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

// Compute every pipe's health for one run. Inventory-sync uses its seam; the
// rest are placeholders until their Phase W unit lands.
export async function computePipelines(sources: Sources): Promise<PipelineHealth[]> {
  const inventory = await computeInventorySyncPipeline(sources);
  const rest = PIPES.filter((p) => p !== 'inventory_sync').map(placeholderPipe);
  return [inventory, ...rest];
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
