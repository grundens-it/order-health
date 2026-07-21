// Snapshot writer skeleton.
//
// The aggregator's job (ADR-0002): on a cadence, READ the sources read-only,
// compute the two-layer model, and WRITE snapshot rows into THIS service's own
// Postgres. Every row it writes is stamped with a single as_of for the run.
//
// STUB STATUS: the verdict computation is stubbed (returns 'unknown' with empty
// source reads) because live sources are DevOps-gated. The SHAPE is real so
// Phase W units drop a real verdict computation into the marked seams.
import { ORDER_HANDOFF_LABEL, type OrderHealth, type PipelineHealth } from '@order-health/shared';
import { config } from '../config';
import { getPool } from '../db/pool';
import type { MiddlewareClient } from '../sources/middlewareClient';
import type { NavClient, NavOrderLifecycleRow, NavOrderLine } from '../sources/navClient';
import type { ShopifyClient } from '../sources/shopifyClient';
import { classifyAwaitingShip } from './awaitingShipClass';
// back_sync + inventory_sync are wired live below (their join keys, order-ref and
// SKU, are reliable). reconcilePrice and reconcileWebhookOutcome are delivered and
// unit-tested but not wired here yet: price needs a NAV price read, and the webhook
// outcome needs a reliable Shopify-order-name to NAV-order match, to avoid surfacing
// false divergences. See shopifyReconcile.ts / ADR-0009.
import { reconcileBackSync, reconcileInventory } from './shopifyReconcile';
import {
  computeDryRunDivergence,
  computeInventorySync,
  type InventorySyncInput,
} from './inventorySync';
import {
  CHANNEL_STAGES,
  computeOrderRows,
  type OrderHop,
  type OrderInput,
} from './orderLifecycle';
import { computeAllocator, type AllocatorInput } from './allocator';
import {
  bucketHeldOrder,
  computeOosHeld,
  extractDroppedSku,
  isNavComplete,
  type HeldNavFacts,
  type OosHeldInput,
} from './oosHeld';
import { classifyHandoff, rollupHandoff, type HandoffResult } from './orderHandoffClass';
import {
  computeFsLocationDivergence,
  type FsLocationDivergenceInput,
  type NavLocationAvailabilityRow,
} from './fsLocationDivergence';
import { MIDDLEWARE_PATHS } from '../sources/middlewareClient';
import type { OosHeldOrder, Verdict } from '@order-health/shared';
import { computeJobQueue, type JobQueueInput } from './jobQueue';
import { computePriceSync, type PriceSyncInput } from './priceSync';
import { computeShopifyWebhook, type ShopifyWebhookInput } from './shopifyWebhook';
import { computeBackSync, type BackSyncInput } from './backSync';
import type { MissedShipment } from '@order-health/shared';
import { diffTransitions, type VerdictSubject } from './transitions';
import {
  applyTransitionActions,
  getOpenTransitions,
  getPreviousVerdicts,
} from '../repo/transitionRepo';

// The set of pipes the strip renders. Phase W units each own one key.
// oos_held (WI1 #87) and fs_location_divergence (WI2 #88) are added additively;
// they do not change any existing pipe's compute.
export const PIPES = [
  'order_handoff',
  'inventory_sync',
  'back_sync',
  'price_sync',
  'nav_job_queue',
  'shopify_webhook',
  'allocator',
  'oos_held',
  'fs_location_divergence',
] as const;

export interface Sources {
  middleware: MiddlewareClient;
  nav: NavClient;
  shopify: ShopifyClient;
}

// ---------------------------------------------------------------------------
// PIPELINE VERDICT SEAM (the pattern Units 2 to 6 copy).
//
// Each pipe has one function that reads its READ-ONLY sources and returns a
// PipelineHealth. The pure verdict math lives in its own module (inventorySync.ts)
// so it is unit-testable without live sources; this function is only the I/O glue:
// read sources -> assemble a seeded input -> call the pure compute -> map to the
// PipelineHealth row shape. See docs/phase-w-adding-a-pipe.md.
// ---------------------------------------------------------------------------
export async function computeInventorySyncPipeline(sources: Sources): Promise<PipelineHealth> {
  // READ-ONLY source reads (currently stubbed: they return typed nulls/empties
  // until DevOps provisions NAV + the middleware endpoint). No live calls, no
  // writes anywhere upstream.
  const [state, walks, status, feed, navAvailability] = await Promise.all([
    sources.nav.getInventoryWatermarkState(),
    sources.nav.getRecentInventoryWalks(8),
    sources.middleware.getInventorySyncStatus(),
    sources.middleware.getInventorySyncFeed(),
    sources.nav.getInventoryAvailability(),
  ]);

  // REBUILD the dry-run "would push" count read-only: current NAV availability vs
  // the quantity last pushed to Shopify per (sku, location). Falls back to the
  // middleware's own dry-run body / null when the sources are absent (issue #37).
  const divergence = computeDryRunDivergence(navAvailability, feed, status.dryRunAt);

  const input: InventorySyncInput = {
    navNewestIabcEntryNo: state.navNewestIabcEntryNo,
    watermarkEntryNo: state.watermarkEntryNo,
    lastWalkAt: state.lastWalkAt,
    watcherHeartbeatAt: state.watcherHeartbeatAt,
    walks,
    dryRunWouldPush: divergence.dryRunWouldPush ?? status.dryRunWouldPush,
    dryRunAt: divergence.dryRunAt ?? status.dryRunAt,
    totalPairs: status.totalPairs,
  };

  const r = computeInventorySync(input, config.inventorySync, Date.now());

  // Shopify reconciliation (ADR-0009): NAV availability vs the inventory level
  // Shopify actually holds, for a bounded SKU sample. Surface-only (annotates the
  // detail, never the verdict); an empty Shopify read reads unavailable (unknown).
  const navBySku = new Map<string, number>();
  for (const row of navAvailability) {
    if (row.sku === null || row.availableQty === null) continue;
    navBySku.set(row.sku, (navBySku.get(row.sku) ?? 0) + row.availableQty);
  }
  const sampleSkus = [...navBySku.keys()].slice(0, 50);
  const levels = await sources.shopify.getInventoryLevels(sampleSkus);
  r.detail.shopify_reconciliation = reconcileInventory(navBySku, levels);

  return {
    pipe: 'inventory_sync',
    pipe_verdict: r.pipeVerdict, // worst of the three, with the dry-run amber cap enforced
    freshness_verdict: r.freshnessVerdict,
    watermark_lag_s: r.watermarkLagS,
    last_progress_at: r.lastProgressAt,
    liveness_verdict: r.livenessVerdict,
    heartbeat_at: r.heartbeatAt,
    heartbeat_age_s: r.heartbeatAgeS,
    // The third (push-outcome) verdict and all the numbers live in the typed
    // detail bag (InventorySyncDetail): divergence + recent-walk stats.
    detail: r.detail as unknown as Record<string, unknown>,
  };
}

// Allocator (Warehouse Split) seam (Unit 4). Reads the middleware's read-only
// allocator status (warehouse_allocation_log), assembles the seeded input, calls
// the pure computeAllocator, and maps the result to the PipelineHealth row.
export async function computeAllocatorPipeline(sources: Sources): Promise<PipelineHealth> {
  // READ-ONLY source read (currently stubbed: returns typed nulls/empties until
  // DevOps provisions the middleware endpoint). No live calls, no upstream writes.
  const status = await sources.middleware.getAllocatorStatus();

  const input: AllocatorInput = {
    lastDecisionAt: status.lastDecisionAt,
    serviceHeartbeatAt: status.serviceHeartbeatAt,
    windowSeconds: status.windowSeconds,
    decisionsWindow: status.decisionsWindow,
    splitCount: status.splitCount,
    unallocatableCount: status.unallocatableCount,
    failedCount: status.failedCount,
    atpFallbackCount: status.atpFallbackCount,
    oosHeldCount: status.oosHeldCount,
    oosHeldOldestAgeS: status.oosHeldOldestAgeS,
    decisions: status.recentDecisions,
  };

  const r = computeAllocator(input, config.allocator, Date.now());

  return {
    pipe: 'allocator',
    pipe_verdict: r.pipeVerdict, // worst of freshness / liveness / split-sanity
    freshness_verdict: r.freshnessVerdict,
    watermark_lag_s: r.decisionLagS,
    last_progress_at: r.lastDecisionAt,
    liveness_verdict: r.livenessVerdict,
    heartbeat_at: r.heartbeatAt,
    heartbeat_age_s: r.heartbeatAgeS,
    // The split-sanity verdict and all the counts live in the typed detail bag
    // (AllocatorDetail): recent split decisions + the sanity signal.
    detail: r.detail as unknown as Record<string, unknown>,
  };
}

// Does a NAV order number belong to this held Shopify order? NAV split legs are
// numbered order_name + "-1" / "-2" / ... (GRUS$Sales Header [No_] LIKE
// order_name + '-%'); an un-split order matches on equality.
function navOrderMatchesName(navOrderNo: string, orderName: string): boolean {
  return navOrderNo === orderName || navOrderNo.startsWith(`${orderName}-`);
}

// OOS-held backlog seam (WI1 #87 + WI3 #89). Reads the read-only /api/oos-held
// backlog, joins each held order to NAV (GRUS$Sales Header presence by [No_] LIKE
// order_name + '-%', and whether the dropped SKU line exists in GRUS$Sales Line),
// buckets it, and calls the pure computeOosHeld. NAV stays read-only; no re-drive
// is fired here (remediation is operator-triggered elsewhere).
export async function computeOosHeldPipeline(sources: Sources): Promise<PipelineHealth> {
  const held = await sources.middleware.getOosHeldOrders();

  let joined: OosHeldOrder[] | null = held;
  if (held !== null && held.length > 0) {
    // WI3 NAV join (read-only). Match held order names to NAV order numbers and
    // gather the SKUs present on those NAV lines so a missing dropped line is
    // distinguishable from a present one.
    const [navOrders, navLines, navShipments, navShippedLines] = await Promise.all([
      sources.nav.getOrderLifecycleRows(),
      sources.nav.getOutstandingOrderLines(5000),
      sources.nav.getRecentShipments(5000),
      sources.nav.getShippedOrderLines(5000),
    ]);
    const navOrderNos = navOrders
      .map((o) => o.navOrderNo)
      .filter((x): x is string => x !== null);
    // Shipped legs prove the order reached NAV even when its open Sales Header is
    // gone (NAV deletes fully-posted headers). This is the per-line fix: a
    // partially-shipped order is still "in NAV" so it never routes to the no-op
    // whole-order re-drive.
    const shippedOrderNos = navShipments
      .map((s) => s.orderRef)
      .filter((x): x is string => x !== null);

    joined = held.map((o) => {
      const orderName = o.order_name;
      if (orderName === null) {
        // No name to join on: treat as line-present (an ops verify), never a re-drive.
        return bucketHeldOrder(o, { inNav: true, droppedSku: null, navLineSkus: [], shippedSkus: [] });
      }
      // NAV presence is evaluated across ALL lines: an open leg OR a posted shipment.
      const inNav =
        navOrderNos.some((no) => navOrderMatchesName(no, orderName)) ||
        shippedOrderNos.some((no) => navOrderMatchesName(no, orderName));
      const navLineSkus = navLines
        .filter((l) => l.orderNo !== null && l.sku !== null && navOrderMatchesName(l.orderNo, orderName))
        .map((l) => l.sku as string);
      const shippedSkus = navShippedLines
        .filter((l) => l.orderNo !== null && l.sku !== null && navOrderMatchesName(l.orderNo, orderName))
        .map((l) => l.sku as string);
      const facts: HeldNavFacts = {
        inNav,
        droppedSku: extractDroppedSku(o.last_detail),
        navLineSkus,
        shippedSkus,
      };
      const bucketed = bucketHeldOrder(o, facts);
      // NAV is the final source of truth. If NAV shows the order complete (shipped,
      // nothing outstanding, the held line itself shipped), mark the lingering
      // middleware hold resolved so it stops driving the verdict red. This kills the
      // false positives like SP-322580 (fully shipped + invoiced, yet still red).
      return isNavComplete(facts) ? { ...bucketed, status: 'resolved' as const } : bucketed;
    });
  }

  const input: OosHeldInput = { heldOrders: joined };
  const r = computeOosHeld(input, config.oosHeld, Date.now());

  return {
    pipe: 'oos_held',
    pipe_verdict: r.heldVerdict, // worst of depth (alerting count) and age (needs_operator)
    freshness_verdict: r.heldVerdict,
    watermark_lag_s: r.detail.oldest_alerting_age_s,
    last_progress_at: null,
    liveness_verdict: r.heldVerdict,
    heartbeat_at: null,
    heartbeat_age_s: null,
    // The counts, the bucket tallies, and the routed per-order list (WI3) live in
    // the typed detail bag (OosHeldDetail).
    detail: r.detail as unknown as Record<string, unknown>,
  };
}

// The reshaped order-health seam. Replaces time-threshold grading with DEFECT-based
// classification, attributing every order to the party that owns the next action.
//
// Reads (all NAV, read-only, all bulk):
//   * open DTC orders + their preseason flag and released status
//   * the Holman EDI 940 handoff state per order (sent / 997-acked)
//   * the active NAV hold reason per order (names Finance or Customer Service)
//   * orders whose autorelease was skipped (EL- / pending CU 5790)
//   * per-SKU availability, to tell a real backorder from a stuck order
//
// Only a genuine handoff failure grades red. An acked 940 is green however old it is:
// Holman being behind is their SLA. Preseason is excluded outright.
export async function computeOrderHandoffPipeline(sources: Sources): Promise<PipelineHealth> {
  const { results, byState, byOwner } = await classifyAllHandoffs(sources);
  return handoffPipelineFrom(results, byState, byOwner);
}

// One classification pass over every open order, shared by the order_handoff PIPE and
// by the ORDER LAYER. Both must agree: it made no sense for the pipe to call an order
// "with Holman" while the order table called the same order "unhealthy" purely because
// its ship stage dot was red. This is the single source of that judgement.
export async function classifyAllHandoffs(sources: Sources): Promise<{
  results: HandoffResult[];
  byOrder: Map<string, HandoffResult>;
  byState: Record<string, number>;
  byOwner: Record<string, number>;
}> {
  const [orders, lines, edi, holds, skipped, avail] = await Promise.all([
    sources.nav.getOrderLifecycleRows(),
    sources.nav.getOutstandingOrderLines(5000),
    sources.nav.getEdiHandoffBulk(config.orderHandoff.ediLookbackDays),
    sources.nav.getActiveHoldsBulk(),
    sources.nav.getAutoReleaseSkippedBulk(),
    sources.nav.getInventoryAvailability(),
  ]);

  const ediByOrder = new Map<string, { sent: boolean; acked: boolean }>();
  for (const e of edi) {
    if (e.orderNo === null) continue;
    ediByOrder.set(e.orderNo, { sent: e.sent === 1, acked: e.acked === 1 });
  }
  const holdByOrder = new Map<string, string>();
  for (const h of holds) {
    if (h.orderNo === null || h.reasonCode === null) continue;
    holdByOrder.set(h.orderNo, h.reasonCode);
  }
  const skippedSet = new Set(skipped);
  const availBySku = new Map<string, number>();
  for (const a of avail) {
    if (a.sku === null || a.availableQty === null) continue;
    availBySku.set(a.sku, (availBySku.get(a.sku) ?? 0) + a.availableQty);
  }
  const linesByOrder = new Map<string, string[]>();
  for (const l of lines) {
    if (l.orderNo === null || l.sku === null) continue;
    const arr = linesByOrder.get(l.orderNo) ?? [];
    arr.push(l.sku);
    linesByOrder.set(l.orderNo, arr);
  }

  const nowMs = Date.now();
  const results: HandoffResult[] = [];
  const byOrder = new Map<string, HandoffResult>();
  const byState: Record<string, number> = {};
  const byOwner: Record<string, number> = {};

  for (const o of orders) {
    const orderNo = o.navOrderNo;
    if (orderNo === null) continue;
    const e = ediByOrder.get(orderNo);
    const skus = linesByOrder.get(orderNo) ?? [];
    const orderAt = o.orderAt ?? o.shopifyOrderAt;
    const ageDays =
      orderAt !== null && orderAt !== undefined
        ? Math.max(0, Math.floor((nowMs - Date.parse(orderAt)) / 86_400_000))
        : 0;

    const r = classifyHandoff({
      isPreseason: o.isPreseason === true,
      released: o.navStatus === 1,
      ediSent: e?.sent === true,
      ediAcked: e?.acked === true,
      ediDocExists: e !== undefined,
      activeHoldReason: holdByOrder.get(orderNo) ?? null,
      autoReleaseSkipped: skippedSet.has(orderNo),
      hasStock: skus.some((s) => (availBySku.get(s) ?? 0) > 0),
      ageDays,
    });
    results.push(r);
    byOrder.set(orderNo, r);
    byState[r.state] = (byState[r.state] ?? 0) + 1;
    byOwner[r.owner] = (byOwner[r.owner] ?? 0) + 1;
  }

  return { results, byOrder, byState, byOwner };
}

// Shape the classified set into the order_handoff pipe row. Pure.
function handoffPipelineFrom(
  results: HandoffResult[],
  byState: Record<string, number>,
  byOwner: Record<string, number>,
): PipelineHealth {
  const roll = rollupHandoff(results);
  const verdict: Verdict =
    roll.verdict === 'red' ? 'red' : roll.verdict === 'amber' ? 'amber' : 'green';

  return {
    pipe: 'order_handoff',
    pipe_verdict: verdict,
    freshness_verdict: verdict,
    watermark_lag_s: null,
    last_progress_at: null,
    liveness_verdict: verdict,
    heartbeat_at: null,
    heartbeat_age_s: null,
    detail: {
      // Only these are OUR pipeline defects. This is the number that replaces the old
      // time-threshold "unhealthy" count.
      defects: roll.defects,
      // Real work, but owned by a named team (Finance / CS) or by engineering (CU 5790).
      owned_elsewhere: roll.ownedElsewhere,
      // With Holman, in flight, or a genuine backorder. Not a defect.
      healthy: roll.healthy,
      // Preseason, graded on stock coverage instead of dates.
      excluded_preseason: roll.excluded,
      by_state: byState,
      by_owner: byOwner,
    } as unknown as Record<string, unknown>,
  };
}

// Per-location availability divergence seam (WI2 #88). Reads NAV IABC availability
// at HF1FTZ (read-only, from getInventoryAvailability filtered to the location) and
// the middleware's FS-location availability, assembles the input, and calls the
// pure computeFsLocationDivergence. SEPARATE from the inventory-sync pipe.
export async function computeFsLocationDivergencePipeline(sources: Sources): Promise<PipelineHealth> {
  const location = config.fsDivergence.navLocationCode;
  const [navAvail, fsInfo] = await Promise.all([
    sources.nav.getInventoryAvailability(),
    sources.middleware.getFulfillmentServiceInfo(),
  ]);

  // NAV side: the availability rows already at HF1FTZ. onHand / earliestShipmentDate
  // are not exposed by the item-ledger read (see the DATA_SOURCES.md follow-up), so
  // they are null; a null ship date is treated as eligible (best-effort).
  const navAtLocation: NavLocationAvailabilityRow[] = navAvail
    .filter((a) => a.location === location && a.sku !== null)
    .map((a) => ({
      sku: a.sku as string,
      available: a.availableQty,
      onHand: null,
      earliestShipmentDate: null,
    }));

  // FS side: null (unread) grades unknown; a present list becomes a per-SKU map.
  const fsAvailBySku =
    fsInfo === null ? null : new Map(fsInfo.map((f) => [f.sku, f.fsAvailable]));

  const input: FsLocationDivergenceInput = {
    navAtLocation,
    fsAvailBySku,
    navLocation: location,
    fsSource: `middleware ${MIDDLEWARE_PATHS.fsInfo}`,
    // The exact per-SKU availability field on fulfillment-service-info is
    // unconfirmed, so the FS side is documented as a proxy (DATA_SOURCES.md + PR).
    fsSourceIsProxy: true,
  };

  const r = computeFsLocationDivergence(input, config.fsDivergence, Date.now());

  return {
    pipe: 'fs_location_divergence',
    pipe_verdict: r.divergenceVerdict,
    freshness_verdict: r.divergenceVerdict,
    watermark_lag_s: null,
    last_progress_at: null,
    liveness_verdict: r.divergenceVerdict,
    heartbeat_at: null,
    heartbeat_age_s: null,
    detail: r.detail as unknown as Record<string, unknown>,
  };
}

// --- Unit 3: price_sync ----------------------------------------------------
// Freshness (last price-sync received) + liveness (last price-sync run), both
// cycle-banded. I/O glue only; the pure math lives in priceSync.ts.
export async function computePriceSyncPipeline(sources: Sources): Promise<PipelineHealth> {
  const status = await sources.middleware.getPriceSyncStatus();

  const input: PriceSyncInput = {
    lastReceivedAt: status.lastReceivedAt,
    lastRunAt: status.lastRunAt,
    enabled: status.enabled,
  };

  const r = computePriceSync(input, config.priceSync, Date.now());

  return {
    pipe: 'price_sync',
    pipe_verdict: r.pipeVerdict,
    freshness_verdict: r.freshnessVerdict,
    watermark_lag_s: r.lastReceivedAgeS, // age of last received price-sync signal
    last_progress_at: r.lastReceivedAt,
    liveness_verdict: r.livenessVerdict,
    heartbeat_at: r.lastRunAt,
    heartbeat_age_s: r.lastRunAgeS,
    detail: r.detail as unknown as Record<string, unknown>,
  };
}

// --- Unit 1: nav_job_queue -------------------------------------------------
// COMPUTE the verdict from read-only NAV (ADR-0007), do NOT adopt the middleware
// level. Read three NAV signals (last CU 50009 auto-release, oldest in-process
// CU 50007, real Status=0 staging backlog); read the middleware's own level and
// stuck-staging count only as a labelled cross-check. The row's freshness column
// carries the liveness (auto-release recency) verdict; the staging sub-verdict
// rides in the detail bag.
export async function computeJobQueuePipeline(sources: Sources): Promise<PipelineHealth> {
  const [nav, mwHealth, mwStuckStaging] = await Promise.all([
    sources.nav.getJobQueueState(),
    sources.middleware.getJobQueueHealthStatus(),
    sources.middleware.getStuckStaging(),
  ]);

  const input: JobQueueInput = {
    // NAV (authoritative).
    autoReleaseFiredAt: nav.autoReleaseFiredAt,
    oldestInProcessJobAt: nav.oldestInProcessJobAt,
    inProcessJobCount: nav.inProcessJobCount,
    pendingStagingCount: nav.pendingStagingCount,
    // Middleware cross-check (monitored, not authoritative).
    middlewareVerdict: mwHealth.verdict,
    middlewareStuckStagingCount: mwStuckStaging.length > 0 ? mwStuckStaging.length : null,
    stuckJobCount: mwHealth.stuckJobCount,
    checkedAt: mwHealth.checkedAt,
  };

  const r = computeJobQueue(input, config.jobQueue, Date.now());

  return {
    pipe: 'nav_job_queue',
    pipe_verdict: r.pipeVerdict,            // worst of liveness / stuck-job / staging
    freshness_verdict: r.livenessVerdict,   // auto-release recency (NAV liveness)
    watermark_lag_s: r.detail.auto_release_age_s,
    last_progress_at: r.lastProgressAt,     // last CU 50009 auto-release firing
    liveness_verdict: r.livenessVerdict,
    heartbeat_at: r.heartbeatAt,
    heartbeat_age_s: null,
    detail: r.detail as unknown as Record<string, unknown>,
  };
}

// --- Unit 3: shopify_webhook -----------------------------------------------
// Per-topic last-received freshness rolled up with the subscription-removal
// signal (a removed/absent subscription is amber-or-worse). Pure math in
// shopifyWebhook.ts.
export async function computeShopifyWebhookPipeline(sources: Sources): Promise<PipelineHealth> {
  const status = await sources.middleware.getShopifyWebhookStatus();

  const input: ShopifyWebhookInput = {
    topics: status.topics.map((t) => ({
      topic: t.topic,
      lastReceivedAt: t.lastReceivedAt,
      subscribed: t.subscribed,
    })),
  };

  const r = computeShopifyWebhook(input, config.shopifyWebhook, Date.now());

  return {
    pipe: 'shopify_webhook',
    pipe_verdict: r.pipeVerdict,
    freshness_verdict: r.freshnessVerdict,     // worst per-topic last-received freshness
    watermark_lag_s: null,
    last_progress_at: r.detail.freshest_received_at,
    liveness_verdict: r.subscriptionVerdict,   // amber-or-worse when a subscription is removed
    heartbeat_at: null,
    heartbeat_age_s: null,
    detail: r.detail as unknown as Record<string, unknown>,
  };
}

// Back-sync pipe seam (Unit 2). Reads the middleware's read-only back-sync status
// and its EXISTING missed-shipments endpoint, enriches missed rows with NAV shipment
// detail (GRUS$Sales Shipment Header, read-only), assembles the seeded input, calls
// the pure computeBackSync, and maps the result to the PipelineHealth row. All reads
// are currently stubbed (typed nulls/empties) until DevOps provisions the sources.
export async function computeBackSyncPipeline(sources: Sources): Promise<PipelineHealth> {
  const [status, missed, shipments, newestDtcShipmentAt] = await Promise.all([
    sources.middleware.getBackSyncStatus(),
    sources.middleware.getMissedShipmentDetail(),
    sources.nav.getRecentShipments(50),
    sources.nav.getNewestDtcShipmentAt(), // Unit 2 has-work gate
  ]);

  // Enrich each missed row with NAV shipment header detail (carrier / tracking /
  // posted time) keyed by NAV shipment number, when the middleware row lacks it.
  const byShipmentNo = new Map(shipments.map((s) => [s.navShipmentNo, s]));
  const enriched: MissedShipment[] | null =
    missed === null
      ? null
      : missed.map((m) => {
          const nav = m.nav_shipment_no !== null ? byShipmentNo.get(m.nav_shipment_no) : undefined;
          return {
            ...m,
            carrier: m.carrier ?? nav?.carrier ?? null,
            tracking: m.tracking ?? nav?.tracking ?? null,
            posted_at: m.posted_at ?? nav?.postedAt ?? null,
            web_id: m.web_id ?? nav?.webId ?? null,
          };
        });

  const input: BackSyncInput = {
    lastBackSyncAt: status.lastBackSyncAt,
    watcherHeartbeatAt: status.watcherHeartbeatAt,
    fulfillmentsLast24h: status.fulfillmentsLast24h,
    errorsLast24h: status.errorsLast24h,
    missedShipments: enriched,
    newestDtcShipmentAt,
  };

  const r = computeBackSync(input, config.backSync, Date.now());

  // Shopify reconciliation (ADR-0009): for the recently NAV-posted DTC shipments,
  // does Shopify actually show a fulfillment? A NAV shipment with no Shopify
  // fulfillment is the divergence to surface, regardless of the middleware feed.
  // Surface-only; an empty Shopify read reads unavailable (unknown).
  const navShippedDtcOrders = shipments
    .filter((s) => s.webId !== null && s.orderRef !== null)
    .map((s) => s.orderRef as string)
    .slice(0, 50);
  const states = await sources.shopify.getFulfillmentStates(navShippedDtcOrders);
  r.detail.shopify_reconciliation = reconcileBackSync(navShippedDtcOrders, states);

  return {
    pipe: 'back_sync',
    pipe_verdict: r.pipeVerdict, // worst of freshness / liveness / missed
    freshness_verdict: r.freshnessVerdict,
    watermark_lag_s: r.watermarkLagS,
    last_progress_at: r.lastProgressAt,
    liveness_verdict: r.livenessVerdict,
    heartbeat_at: r.heartbeatAt,
    heartbeat_age_s: r.heartbeatAgeS,
    // The missed-shipments sub-verdict, counters, and detail rows for the panel
    // table live in the typed detail bag (BackSyncDetail).
    detail: r.detail as unknown as Record<string, unknown>,
  };
}

// A generic placeholder pipe so the strip has a full row set before each Phase W
// unit lands its real compute. Same PipelineHealth shape as the seam above.
function placeholderPipe(pipe: string): PipelineHealth {
  return {
    pipe,
    pipe_verdict: 'unknown',
    freshness_verdict: 'unknown',
    watermark_lag_s: null,
    last_progress_at: null,
    liveness_verdict: 'unknown',
    heartbeat_at: null,
    heartbeat_age_s: null,
    detail: { note: 'stub: populated by Phase W units' },
  };
}

// Compute every pipe's health for one run. Each landed Phase W unit adds its real
// seam to the `real` map; the rest stay placeholders. The strip order is fixed by
// PIPES so units can add their entry additively without reordering the row set.
export async function computePipelines(sources: Sources): Promise<PipelineHealth[]> {
  const landed = await Promise.all([
    computeInventorySyncPipeline(sources),
    computeBackSyncPipeline(sources),       // Unit 2
    computePriceSyncPipeline(sources),      // Unit 3
    computeJobQueuePipeline(sources),       // Unit 3
    computeShopifyWebhookPipeline(sources), // Unit 3
    computeAllocatorPipeline(sources),      // Unit 4
    computeOosHeldPipeline(sources),        // WI1 (#87)
    computeFsLocationDivergencePipeline(sources), // WI2 (#88)
    computeOrderHandoffPipeline(sources),   // reshaped, defect-based order health
  ]);
  const real = new Map<string, PipelineHealth>(landed.map((p) => [p.pipe, p]));
  return PIPES.map((p) => real.get(p) ?? placeholderPipe(p));
}

// ---------------------------------------------------------------------------
// ORDER VERDICT SEAM (the order-layer analogue of the pipe seam above).
//
// Read the READ-ONLY sources, assemble a seeded OrderInput per order, and call
// the pure grader (orderLifecycle.ts). The pure math is unit-tested without live
// sources; this function is only the I/O glue. Sources are stubbed (return empty)
// until DevOps provisions NAV + the middleware endpoints, so this currently
// yields an empty snapshot with no live calls.
// ---------------------------------------------------------------------------

// Map one read-only NAV lifecycle row to the seeded OrderInput the grader takes
// (Unit 6, health-fidelity; see docs/business/order-layer-red-rate-finding-2026-07-13.md).
//
// THE JOIN FIX. Four DTC hop completions are middleware-sourced and NOT observable
// from read-only NAV, so a live row carries them null: allocatorSplitAt, navStagingAt,
// navPromotionAt, backSyncAt. Reading those nulls as "never happened" pinned every
// order at allocator_split and aged it from the order date against the tight staging
// band, reddening 98.9% of a healthy board. Per ADR-0007, NAV read-only is the system
// of record: the authoritative per-order evidence is that the order was RECEIVED
// (orderDate), whether it SHIPPED (navShipmentAt), the staging Status, and the
// missed-back-sync reconciliation. So INFER each unobservable completion from that
// evidence (assume the middleware's step landed unless NAV shows a fault) instead of
// aging a null as if stuck. When a real timestamp IS present (seeded fixtures, or a
// future source that provides it) it is used unchanged, so the grader and its tests
// are untouched.
export function buildOrderInput(row: NavOrderLifecycleRow): OrderInput {
  const shipped = row.navShipmentAt !== null;
  // The received-time anchor. DTC carries the NAV order date; wholesale has none in
  // the read-only row, so an unshipped wholesale order has no anchor and reads
  // unknown (never a false red) rather than being aged.
  const receivedAt = row.shopifyOrderAt;
  // Inferred completion for an unobservable intermediate hop: the shipment time when
  // shipped, else the received time (the order is in flight, awaiting shipment).
  const inferredMidCompletion = shipped ? row.navShipmentAt : receivedAt;
  // Unit D (health-fidelity integration): staging Status is NOT a per-order stuck
  // signal. Live NAV shows GRUS$Sales Header Staging [Status] = 1 ("Not Auto-released")
  // is the ordinary early-lifecycle state of a freshly received DTC order (530 of 533
  // reds were recent Status=1 orders, median age 1 day). No field in the read-only
  // order-lifecycle query identifies a GENUINELY stuck staging row, so a status FLAG
  // cannot be a truthful red. The honest per-order signal is age based: an unshipped
  // order is aged at its awaiting_ship frontier against the awaiting-ship band. The
  // Status=1 backlog remains a PIPE signal (nav_job_queue), not a per-order red.
  // See docs/business/order-layer-residual-red-finding-2026-07-13.md.
  // Back-sync completion is unobservable; infer it from the shipment plus the
  // missed-back-sync reconciliation. A missed back-sync leaves it incomplete + latched.
  const backSynced = shipped && !row.missedBackSync;

  // Completion timestamp per stage. Real timestamp if the source provides one, else
  // the NAV-evidence inference. awaiting_ship / nav_shipment complete on the shipment.
  const completedAtByStage: Partial<Record<OrderHop['stage'], string | null>> = {
    shopify_order: row.shopifyOrderAt,
    allocator_split: row.allocatorSplitAt ?? inferredMidCompletion,
    nav_staging: row.navStagingAt ?? inferredMidCompletion,
    nav_promotion: row.navPromotionAt ?? inferredMidCompletion,
    awaiting_ship: row.navShipmentAt,
    nav_shipment: row.navShipmentAt,
    back_sync: row.backSyncAt ?? (backSynced ? row.navShipmentAt : null),
  };

  const hops: OrderHop[] = [];
  let prevCompletedAt: string | null = null;
  for (const stage of CHANNEL_STAGES[row.channel]) {
    const completedAt = completedAtByStage[stage] ?? null;

    // Latched errors promote a hop straight to RED (design.md 5). The only
    // NAV-observable per-order fault kept is a missed back-sync (a NAV shipment
    // posted with no Shopify fulfillment); the staging-status flag is NOT a fault
    // (Unit D). An order stuck in staging surfaces as an unshipped order aged past
    // the awaiting-ship SLO, not as a status flag.
    let error: string | null = null;
    if (stage === 'back_sync' && row.missedBackSync) {
      error = 'Missed back-sync: NAV shipment exists with no Shopify fulfillment';
    }

    // The order entered a hop when the previous hop completed.
    hops.push({ stage, completedAt, enteredAt: prevCompletedAt, error });
    prevCompletedAt = completedAt;
  }

  return {
    channel: row.channel,
    navOrderNo: row.navOrderNo,
    shopifyOrderName: row.shopifyOrderName,
    customerRef: row.customerRef,
    webId: row.webId,
    // Carry [WebOrder] through so the orphan predicate can gate on it (DATA_SOURCES).
    webOrder: row.webOrder,
    hops,
  };
}

// Round 3 (Unit 2). A Happy Return / non-sales record: GRUS$Sales Header Document
// Type 5 (Return Order), which live NAV shows carry "HR-" numbers and an empty
// customer. It is NOT an outbound shipment, so it must never be graded awaiting_ship.
function isReturnRow(row: NavOrderLifecycleRow): boolean {
  return row.documentType === 5 || (row.navOrderNo?.startsWith('HR-') ?? false);
}

export async function computeOrders(sources: Sources): Promise<OrderHealth[]> {
  const [rows] = await Promise.all([
    sources.nav.getOrderLifecycleRows(),
    sources.middleware.getErrors(), // errors view feeds latched hop errors in the live join
  ]);
  const now = Date.now();

  const inputs = rows.map(buildOrderInput);
  // config.order carries the SLO bands and the orphan-grading flag (default OFF).
  const graded = computeOrderRows(inputs, config.order, now);
  // graded[i] corresponds to rows[i] (1:1 map through buildOrderInput).
  const paired = graded.map((health, i) => ({ health, row: rows[i]! }));

  // Unit 2: reclassify returns out of awaiting_ship. A return is not a stall.
  for (const { health, row } of paired) {
    if (!isReturnRow(row)) continue;
    health.order_verdict = 'green';
    health.current_stage = 'complete';
    health.oldest_stuck_age_s = null;
    health.classification = 'return';
    health.awaiting_ship_detail = {
      classification: 'return',
      age_s: null,
      fs_available: null,
      nav_warehouse_on_hand: null,
      sample_sku: null,
      why: 'Happy Return / non-sales record (Document Type 5); not an outbound shipment stall',
    };
    health.note = 'Return order (excluded from awaiting_ship grading)';
  }

  // Unit 1: classify the awaiting_ship red/amber orders by FS vs warehouse on-hand.
  const awaiting = paired.filter(
    (p) =>
      !isReturnRow(p.row) &&
      p.health.current_stage === 'awaiting_ship' &&
      (p.health.order_verdict === 'red' || p.health.order_verdict === 'amber'),
  );
  if (awaiting.length > 0) {
    await classifyAwaitingShipOrders(sources, awaiting.map((a) => a.health));
  }

  // Round 4: the ORDER VERDICT now comes from the handoff classifier, not from the
  // stage grading. The old behaviour graded an order red purely because its ship stage
  // dot was red, i.e. purely on elapsed time, which meant a clean, EDI-acknowledged
  // handoff sitting in Holman's queue was reported as "stuck" and an operator was sent
  // to chase something that is not ours and has no defect. Ownership, not age:
  //   red   = OUR defect (the handoff actually failed)
  //   amber = real work owned by a named party (Holman past their window, Finance / CS
  //           hold, or the CU 5790 code defect)
  //   green = with Holman inside the window, in flight, or a genuine backorder
  //   excluded (preseason) is carried as green and labelled; it has its own card
  // The stage dot is left untouched so the lifecycle view still shows WHERE the order
  // is; the verdict now says WHOSE it is.
  await applyHandoffVerdicts(sources, paired);
  return graded;
}

// Overlay the handoff classification onto graded order rows. Orders with no NAV order
// number (orphan / Shopify-only records) keep their legacy grading: there is no NAV
// handoff to classify, and those are exactly the records the orphan grading exists for.
async function applyHandoffVerdicts(
  sources: Sources,
  paired: { health: OrderHealth; row: NavOrderLifecycleRow }[],
): Promise<void> {
  let byOrder: Map<string, HandoffResult>;
  try {
    ({ byOrder } = await classifyAllHandoffs(sources));
  } catch (err) {
    // If the handoff reads fail we keep the legacy verdicts rather than silently
    // grading everything green. A missing overlay is visible; a false green is not.
    console.error('[aggregator] handoff classification failed, keeping stage verdicts', err);
    return;
  }

  for (const { health } of paired) {
    const orderNo = health.nav_order_no;
    if (orderNo === null) continue;
    const r = byOrder.get(orderNo);
    if (r === undefined) continue;
    // A return was already resolved above and must stay green.
    if (health.classification === 'return') continue;
    // NEVER downgrade a PROVEN defect. fs_floor_at_zero is a measured middleware bug
    // (NAV warehouse stocked while the FS location reads negative) with a real fix, and
    // it is invisible to the EDI view: a TAC order cuts no 940, so the handoff
    // classifier would call it "in flight" and quietly hide a genuine stall. The
    // classifier grades the Holman handoff; it does not get to overrule evidence.
    if (health.classification === 'fs_floor_at_zero') continue;

    health.order_verdict = r.verdict === 'red' ? 'red' : r.verdict === 'amber' ? 'amber' : 'green';
    health.handoff = {
      state: r.state,
      owner: r.owner,
      reason: r.reason,
      label: ORDER_HANDOFF_LABEL[r.state],
    };
    health.note = r.reason;
    // "Oldest stuck age" must measure OUR defects only, otherwise it just reports how
    // far behind Holman is and the headline goes red for someone else's backlog.
    if (health.order_verdict !== 'red') health.oldest_stuck_age_s = null;
  }
}

// Round 3 (Unit 1). Gather the FS-location available (Shopify) and NAV warehouse
// on-hand for the awaiting_ship orders' SKUs, then classify each in place. The
// classifier is pure; this is the I/O glue. Read-only everywhere.
async function classifyAwaitingShipOrders(sources: Sources, orders: OrderHealth[]): Promise<void> {
  const orderNos = new Set(orders.map((o) => o.nav_order_no).filter((x): x is string => x !== null));
  const [lines, navAvail] = await Promise.all([
    sources.nav.getOutstandingOrderLines(5000),
    sources.nav.getInventoryAvailability(),
  ]);

  const linesByOrder = new Map<string, NavOrderLine[]>();
  for (const l of lines) {
    if (l.orderNo === null || l.sku === null || !orderNos.has(l.orderNo)) continue;
    const arr = linesByOrder.get(l.orderNo) ?? [];
    arr.push(l);
    linesByOrder.set(l.orderNo, arr);
  }

  // NAV warehouse on-hand per SKU (summed across NAV locations; the FS location is
  // a Shopify virtual location, absent from NAV, so all NAV locations are warehouses).
  const navOnHandBySku = new Map<string, number>();
  for (const a of navAvail) {
    if (a.sku === null || a.availableQty === null) continue;
    navOnHandBySku.set(a.sku, (navOnHandBySku.get(a.sku) ?? 0) + a.availableQty);
  }

  // FS-location available per SKU. Prioritize the RED (genuine stall) orders' SKUs so
  // the FS floor-at-zero bug is always detected for them even under a bounded read;
  // amber orders fill the remainder. The client chunks the read by 100 (the GraphQL
  // productVariants cap), so a larger bound is a few queries, not a truncation.
  const ordered = [...orders].sort(
    (a, b) => Number(b.order_verdict === 'red') - Number(a.order_verdict === 'red'),
  );
  const skuList: string[] = [];
  const seen = new Set<string>();
  for (const o of ordered) {
    const arr = o.nav_order_no !== null ? (linesByOrder.get(o.nav_order_no) ?? []) : [];
    for (const l of arr) {
      if (l.sku !== null && !seen.has(l.sku)) {
        seen.add(l.sku);
        skuList.push(l.sku);
      }
    }
    if (skuList.length >= 500) break;
  }
  const fsLevels = await sources.shopify.getFsInventory(skuList);
  const fsBySku = new Map<string, number | null>();
  for (const f of fsLevels) fsBySku.set(f.sku, f.available);

  for (const o of orders) {
    const orderLines = o.nav_order_no !== null ? (linesByOrder.get(o.nav_order_no) ?? []) : [];
    // Pick the representative SKU: an FS-floored line first (FS < 0 while warehouse
    // stocked), else a warehouse-short line, else the first line.
    let repSku: string | null = null;
    let repFs: number | null = null;
    let repWh: number | null = null;
    let backorder = false;
    for (const l of orderLines) {
      if (l.sku === null) continue;
      const fs = fsBySku.has(l.sku) ? (fsBySku.get(l.sku) ?? null) : null;
      const wh = navOnHandBySku.has(l.sku) ? navOnHandBySku.get(l.sku)! : null;
      if (fs !== null && fs < 0 && wh !== null && wh > 0) {
        repSku = l.sku; repFs = fs; repWh = wh; backorder = false;
        break; // FS floor-at-zero dominates; stop at the first.
      }
      if (wh !== null && wh <= 0) {
        if (repSku === null) { repSku = l.sku; repFs = fs; repWh = wh; }
        backorder = true;
      } else if (repSku === null) {
        repSku = l.sku; repFs = fs; repWh = wh;
      }
    }
    const detail = classifyAwaitingShip({
      ageS: o.oldest_stuck_age_s,
      fsAvailable: repFs,
      navWarehouseOnHand: repWh,
      sampleSku: repSku,
      hasNavOrder: o.nav_order_no !== null,
      hasShopifyOrder: o.shopify_order_id !== null,
      isReturn: false,
      backorder,
    });
    o.classification = detail.classification;
    o.awaiting_ship_detail = detail;
    o.note = detail.why;
  }
}

// Persist one order-layer snapshot run, all rows stamped with the same as_of.
export async function writeOrderSnapshot(asOf: string, orders: OrderHealth[]): Promise<void> {
  const pool = getPool();
  if (pool === null) {
    // eslint-disable-next-line no-console
    console.info(`[aggregator] order snapshot (${orders.length} rows) computed; no DB, not persisted`);
    return;
  }
  for (const o of orders) {
    await pool.query(
      `INSERT INTO order_health_snapshot
         (as_of, channel, nav_order_no, shopify_order_id, shopify_order_name,
          customer_ref, current_stage, order_verdict, oldest_stuck_age_s,
          is_orphan_suspect, note, classification, awaiting_ship_detail, handoff)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        asOf, o.channel, o.nav_order_no, o.shopify_order_id, o.shopify_order_name,
        o.customer_ref, o.current_stage, o.order_verdict, o.oldest_stuck_age_s,
        o.is_orphan_suspect, o.note, o.classification ?? null,
        o.awaiting_ship_detail ? JSON.stringify(o.awaiting_ship_detail) : null,
        o.handoff ? JSON.stringify(o.handoff) : null,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// health_transition WIRING (Unit 7, design.md 8).
//
// The snapshot writer is the single evaluation point. On each run we read the
// PREVIOUS snapshot's verdicts and the currently-open transition rows, run the
// PURE diff (transitions.ts) against the newly-computed subjects, and append /
// resolve rows. This is I/O glue ONLY: the verdict-change decision is the pure,
// unit-tested diff. It writes ONLY this service's own health_transition table and
// NEVER invokes remediation (no import of the remediation client here).
// ---------------------------------------------------------------------------

// Map an order snapshot row to its transition subject key (channel-agnostic).
function orderSubjectKey(o: OrderHealth): string | null {
  return o.nav_order_no ?? o.shopify_order_name ?? o.shopify_order_id ?? o.customer_ref ?? null;
}

// Record verdict transitions for the pipeline layer. Reads previous verdicts +
// open rows BEFORE the diff (the new snapshot is already written by the caller).
export async function recordPipelineTransitions(asOf: string, pipes: PipelineHealth[]): Promise<void> {
  const [previous, open] = await Promise.all([getPreviousVerdicts(), getOpenTransitions()]);
  const current: VerdictSubject[] = pipes.map((p) => ({
    subjectKind: 'pipe',
    subjectKey: p.pipe,
    verdict: p.pipe_verdict,
  }));
  const actions = diffTransitions(previous, current, open, asOf);
  await applyTransitionActions(actions);
}

// Record verdict transitions for the order layer, keyed by the order's stable ref.
export async function recordOrderTransitions(asOf: string, orders: OrderHealth[]): Promise<void> {
  const [previous, open] = await Promise.all([getPreviousVerdicts(), getOpenTransitions()]);
  const current: VerdictSubject[] = [];
  for (const o of orders) {
    const key = orderSubjectKey(o);
    if (key !== null) current.push({ subjectKind: 'order', subjectKey: key, verdict: o.order_verdict });
  }
  const actions = diffTransitions(previous, current, open, asOf);
  await applyTransitionActions(actions);
}

// Persist one pipeline-layer snapshot run, all rows stamped with the same as_of.
export async function writePipelineSnapshot(asOf: string, pipes: PipelineHealth[]): Promise<void> {
  const pool = getPool();
  if (pool === null) {
    // eslint-disable-next-line no-console
    console.info(`[aggregator] pipeline snapshot (${pipes.length} rows) computed; no DB, not persisted`);
    return;
  }
  for (const p of pipes) {
    await pool.query(
      `INSERT INTO pipeline_health_snapshot
         (as_of, pipe, pipe_verdict, freshness_verdict, watermark_lag_s,
          last_progress_at, liveness_verdict, heartbeat_at, heartbeat_age_s, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        asOf, p.pipe, p.pipe_verdict, p.freshness_verdict, p.watermark_lag_s,
        p.last_progress_at, p.liveness_verdict, p.heartbeat_at, p.heartbeat_age_s,
        JSON.stringify(p.detail),
      ],
    );
  }
}
