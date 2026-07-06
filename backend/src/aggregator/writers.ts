// Snapshot writer skeleton.
//
// The aggregator's job (ADR-0002): on a cadence, READ the sources read-only,
// compute the two-layer model, and WRITE snapshot rows into THIS service's own
// Postgres. Every row it writes is stamped with a single as_of for the run.
//
// STUB STATUS: the verdict computation is stubbed (returns 'unknown' with empty
// source reads) because live sources are DevOps-gated. The SHAPE is real so
// Phase W units drop a real verdict computation into the marked seams.
import type { OrderHealth, PipelineHealth, Verdict } from '@order-health/shared';
import { worstVerdict } from '@order-health/shared';
import { getPool } from '../db/pool';
import type { MiddlewareClient } from '../sources/middlewareClient';
import type { NavClient } from '../sources/navClient';

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
// PIPELINE VERDICT SEAM (the pattern Unit 1 copies).
//
// Each pipe has one function that reads its sources and returns a PipelineHealth
// with real freshness + liveness sub-verdicts. The rollup pipe_verdict is
// worstVerdict([...]). Unit 1 (inventory monitor) replaces the body of
// computeInventorySyncPipeline with the real three-verdict compute from
// design.md 5A.2; the other pipes follow the identical shape.
// ---------------------------------------------------------------------------
export async function computeInventorySyncPipeline(sources: Sources): Promise<PipelineHealth> {
  // STUB: read the (stubbed) watermark state. Unit 1 turns these into verdicts:
  //   freshness_verdict from watermark_lag vs one IABC cycle (~2h),
  //   liveness_verdict  from heartbeat_age vs N cycles,
  //   plus a push-outcome / dry-run divergence sub-verdict in detail.
  const state = await sources.nav.getInventoryWatermarkState();

  const freshness_verdict: Verdict = 'unknown';
  const liveness_verdict: Verdict = 'unknown';

  return {
    pipe: 'inventory_sync',
    // Rollup = worst of the sub-verdicts. This line stays; only the inputs change.
    pipe_verdict: worstVerdict([freshness_verdict, liveness_verdict]),
    freshness_verdict,
    watermark_lag_s: null,
    last_progress_at: state.lastWalkAt,
    liveness_verdict,
    heartbeat_at: state.watcherHeartbeatAt,
    heartbeat_age_s: null,
    detail: {
      note: 'stub: populated by Unit 1 (inventory monitor)',
      nav_newest_iabc_entry_no: state.navNewestIabcEntryNo,
      watermark_entry_no: state.watermarkEntryNo,
    },
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

// Order-layer compute. STUB: returns no orders (the source reads are stubbed).
// Phase W joins Shopify/NAV per order and grades each stage. Channel stays
// first-class so wholesale is never mis-graded as an orphan.
export async function computeOrders(sources: Sources): Promise<OrderHealth[]> {
  await sources.middleware.getErrors();
  return [];
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
