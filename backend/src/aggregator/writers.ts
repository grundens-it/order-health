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
import type { NavClient } from '../sources/navClient';
import { computeInventorySync, type InventorySyncInput } from './inventorySync';
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

// Compute every pipe's health for one run. Inventory-sync uses its seam; the
// rest are placeholders until their Phase W unit lands.
export async function computePipelines(sources: Sources): Promise<PipelineHealth[]> {
  const [inventory, backSync] = await Promise.all([
    computeInventorySyncPipeline(sources),
    computeBackSyncPipeline(sources),
  ]);
  const wired = new Set(['inventory_sync', 'back_sync']);
  const rest = PIPES.filter((p) => !wired.has(p)).map(placeholderPipe);
  return [inventory, backSync, ...rest];
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
