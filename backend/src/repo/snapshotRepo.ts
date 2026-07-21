// Read-model repository. Serves the LATEST snapshot from this service's own
// Postgres. No live source calls in the request path (ADR-0002): page loads hit
// only local Postgres. When no DATABASE_URL is configured it falls back to an
// empty stub so the scaffold's API responds without a live database.
import type {
  Channel,
  ChannelFilter,
  LeadershipRollup,
  OrderHealth,
  PipelineHealth,
} from '@order-health/shared';
import { hasDatabase } from '../config';
import { computeRollup } from '../aggregator/rollup';
import { getPool, query } from '../db/pool';

export interface Snapshot<T> {
  asOf: string;
  rows: T[];
}

// Latest pipeline snapshot: the newest as_of, one row per pipe.
export async function latestPipelines(): Promise<Snapshot<PipelineHealth>> {
  if (!hasDatabase()) {
    return { asOf: new Date().toISOString(), rows: [] };
  }
  const pool = getPool();
  if (pool === null) return { asOf: new Date().toISOString(), rows: [] };

  const asOfRows = await query<{ as_of: Date }>(
    'SELECT max(as_of) AS as_of FROM pipeline_health_snapshot',
  );
  const asOf = asOfRows[0]?.as_of;
  if (!asOf) return { asOf: new Date().toISOString(), rows: [] };

  const rows = await query<PipelineHealth & { as_of: Date }>(
    `SELECT pipe, pipe_verdict, freshness_verdict, watermark_lag_s,
            last_progress_at, liveness_verdict, heartbeat_at, heartbeat_age_s, detail
       FROM pipeline_health_snapshot
      WHERE as_of = $1
      ORDER BY pipe`,
    [asOf],
  );
  return { asOf: asOf.toISOString(), rows };
}

// Latest order snapshot, optionally filtered by channel ('all' returns both).
export async function latestOrders(filter: ChannelFilter): Promise<Snapshot<OrderHealth>> {
  if (!hasDatabase()) {
    return { asOf: new Date().toISOString(), rows: [] };
  }
  const pool = getPool();
  if (pool === null) return { asOf: new Date().toISOString(), rows: [] };

  const asOfRows = await query<{ as_of: Date }>(
    'SELECT max(as_of) AS as_of FROM order_health_snapshot',
  );
  const asOf = asOfRows[0]?.as_of;
  if (!asOf) return { asOf: new Date().toISOString(), rows: [] };

  const wantChannel = filter !== 'all';
  const params: unknown[] = wantChannel ? [asOf, filter as Channel] : [asOf];
  const rows = await query<OrderHealth>(
    `SELECT channel, nav_order_no, shopify_order_id, shopify_order_name,
            customer_ref, current_stage, order_verdict, oldest_stuck_age_s,
            is_orphan_suspect, note, classification, awaiting_ship_detail, handoff
       FROM order_health_snapshot
      WHERE as_of = $1 ${wantChannel ? 'AND channel = $2' : ''}
      ORDER BY order_verdict DESC, oldest_stuck_age_s DESC NULLS LAST`,
    params,
  );
  return { asOf: asOf.toISOString(), rows };
}

// Latest leadership rollup. READ-ONLY: it reuses the two latest-snapshot reads
// above (all pipes + all orders) and folds them with the pure computeRollup. No
// new source, no live call. The rollup's as_of is the OLDER of the two layer
// snapshots so it never claims to be fresher than its stalest input.
export async function latestRollup(): Promise<{ asOf: string; rollup: LeadershipRollup }> {
  const [pipes, orders] = await Promise.all([latestPipelines(), latestOrders('all')]);
  const asOf = pipes.asOf < orders.asOf ? pipes.asOf : orders.asOf;
  return { asOf, rollup: computeRollup(pipes.rows, orders.rows) };
}
