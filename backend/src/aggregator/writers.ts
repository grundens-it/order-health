// Snapshot writer skeleton.
//
// The aggregator's job (ADR-0002): on a cadence, READ the sources read-only,
// compute the two-layer model, and WRITE snapshot rows into THIS service's own
// Postgres. Every row it writes is stamped with a single as_of for the run.
//
// STUB STATUS: the verdict computation is stubbed (returns 'unknown' with empty
// source reads) because live sources are DevOps-gated. The SHAPE is real so
// Phase W units drop a real verdict computation into the marked seams.
import type { OrderHealth, PipelineHealth } from '@order-health/shared';
import { config } from '../config';
import { getPool } from '../db/pool';
import type { MiddlewareClient } from '../sources/middlewareClient';
import type { NavClient, NavOrderLifecycleRow } from '../sources/navClient';
import { computeInventorySync, type InventorySyncInput } from './inventorySync';
import {
  CHANNEL_STAGES,
  computeOrderRows,
  type OrderHop,
  type OrderInput,
} from './orderLifecycle';
import { computeAllocator, type AllocatorInput } from './allocator';
import { computeJobQueue, type JobQueueInput } from './jobQueue';
import { computePriceSync, type PriceSyncInput } from './priceSync';
import { computeShopifyWebhook, type ShopifyWebhookInput } from './shopifyWebhook';
import { computeBackSync, type BackSyncInput } from './backSync';
import type { MissedShipment } from '@order-health/shared';

// The set of pipes the strip renders. Phase W units each own one key.
export const PIPES = [
  'inventory_sync',
  'back_sync',
  'price_sync',
  'nav_job_queue',
  'shopify_webhook',
  'allocator',
] as const;

export interface Sources {
  middleware: MiddlewareClient;
  nav: NavClient;
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
  const [state, walks, status] = await Promise.all([
    sources.nav.getInventoryWatermarkState(),
    sources.nav.getRecentInventoryWalks(8),
    sources.middleware.getInventorySyncStatus(),
  ]);

  const input: InventorySyncInput = {
    navNewestIabcEntryNo: state.navNewestIabcEntryNo,
    watermarkEntryNo: state.watermarkEntryNo,
    lastWalkAt: state.lastWalkAt,
    watcherHeartbeatAt: state.watcherHeartbeatAt,
    walks,
    dryRunWouldPush: status.dryRunWouldPush,
    dryRunAt: status.dryRunAt,
    totalPairs: status.totalPairs,
  };

  const r = computeInventorySync(input, config.inventorySync, Date.now());

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

// --- Unit 3: price_sync ----------------------------------------------------
// Freshness (last price-sync received) + liveness (last price-sync run), both
// cycle-banded. I/O glue only; the pure math lives in priceSync.ts.
export async function computePriceSyncPipeline(sources: Sources): Promise<PipelineHealth> {
  const status = await sources.middleware.getPriceSyncStatus();

  const input: PriceSyncInput = {
    lastReceivedAt: status.lastReceivedAt,
    lastRunAt: status.lastRunAt,
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

// --- Unit 3: nav_job_queue -------------------------------------------------
// CONSUME the middleware's already-computed job-queue verdict; do NOT recompute
// it (design.md 6). The row's three verdict columns all reflect that single
// adopted verdict (this pipe derives no independent freshness/liveness); the
// supporting numbers ride in the typed detail bag.
export async function computeJobQueuePipeline(sources: Sources): Promise<PipelineHealth> {
  const status = await sources.middleware.getJobQueueHealthStatus();

  const input: JobQueueInput = {
    middlewareVerdict: status.verdict,
    autoReleaseFiredAt: status.autoReleaseFiredAt,
    longestRunningJobS: status.longestRunningJobS,
    stuckJobCount: status.stuckJobCount,
    checkedAt: status.checkedAt,
  };

  const r = computeJobQueue(input, config.jobQueue, Date.now());

  return {
    pipe: 'nav_job_queue',
    pipe_verdict: r.pipeVerdict,           // == the adopted middleware verdict
    freshness_verdict: r.adoptedVerdict,   // mirrors the single consumed verdict
    watermark_lag_s: null,
    last_progress_at: r.lastProgressAt,    // last CU 50009 auto-release firing
    liveness_verdict: r.adoptedVerdict,    // mirrors the single consumed verdict
    heartbeat_at: r.detail.checked_at,
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
  const [status, missed, shipments] = await Promise.all([
    sources.middleware.getBackSyncStatus(),
    sources.middleware.getMissedShipmentDetail(),
    sources.nav.getRecentShipments(50),
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
  };

  const r = computeBackSync(input, config.backSync, Date.now());

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

// Map one read-only NAV lifecycle row to the seeded OrderInput the grader takes.
// The per-channel chain (CHANNEL_STAGES) decides which hops exist, so wholesale
// simply has no shopify_order / allocator_split / back_sync hop to grade.
function buildOrderInput(row: NavOrderLifecycleRow): OrderInput {
  // Completion timestamp per stage. awaiting_ship completes when the shipment
  // exists (same signal as nav_shipment), which is what moves a promoted order
  // off "awaiting ship".
  const completedAtByStage: Partial<Record<OrderHop['stage'], string | null>> = {
    shopify_order: row.shopifyOrderAt,
    allocator_split: row.allocatorSplitAt,
    nav_staging: row.navStagingAt,
    nav_promotion: row.navPromotionAt,
    awaiting_ship: row.navShipmentAt,
    nav_shipment: row.navShipmentAt,
    back_sync: row.backSyncAt,
  };

  const hops: OrderHop[] = [];
  let prevCompletedAt: string | null = null;
  for (const stage of CHANNEL_STAGES[row.channel]) {
    const completedAt = completedAtByStage[stage] ?? null;

    // Latched errors promote a hop straight to RED (design.md 5).
    let error: string | null = null;
    if (
      stage === 'nav_staging' &&
      row.navStagingStatus !== null &&
      row.navStagingStatus !== 0 &&
      row.navPromotionAt === null
    ) {
      error = `NAV staging stuck (Status ${row.navStagingStatus})`;
    }
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
    hops,
  };
}

export async function computeOrders(sources: Sources): Promise<OrderHealth[]> {
  // READ-ONLY source reads (stubbed: NAV returns [] and the middleware errors
  // view returns [] until DevOps provisions access). No live calls, no writes.
  const [rows] = await Promise.all([
    sources.nav.getOrderLifecycleRows(),
    sources.middleware.getErrors(), // errors view feeds latched hop errors in the live join
  ]);

  const inputs = rows.map(buildOrderInput);
  // config.order carries the SLO bands and the orphan-grading flag (default OFF).
  return computeOrderRows(inputs, config.order, Date.now());
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
          is_orphan_suspect, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        asOf, o.channel, o.nav_order_no, o.shopify_order_id, o.shopify_order_name,
        o.customer_ref, o.current_stage, o.order_verdict, o.oldest_stuck_age_s,
        o.is_orphan_suspect, o.note,
      ],
    );
  }
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
