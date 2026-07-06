// Leadership rollup: the headline-verdict compute (design.md section 6, Unit 6).
//
// This mirrors the inventorySync.ts style: a PURE function of seeded inputs (no
// I/O, no clock read), so every headline boundary is unit-testable without a
// live source. Unlike the pipe computes, it reads NO external source at all: it
// is derived entirely from the EXISTING latest snapshot rows (pipeline_health +
// order_health) the read API already serves. The aggregator does not write a
// rollup table; the endpoint computes it on read from those two row sets.
//
// Derivations:
//   - headline / headline_verdict: worst-wins over the OBSERVED (non-unknown)
//     pipe and order verdicts, mapped to a bucket. red => stuck, amber =>
//     at_risk, green => healthy, none-observed => healthy-empty (unknown chip).
//   - oldest_stuck_age_s: max oldest_stuck_age_s across the RED (stuck) orders.
//   - inventory_sync_fresh: the inventory_sync pipe's freshness verdict, as a
//     yes / no / unknown.
import type {
  LeadershipRollup,
  OrderHealth,
  PipelineHealth,
  RollupCounts,
  RollupHeadline,
  Verdict,
} from '@order-health/shared';
import { worstVerdict } from '@order-health/shared';

// Tally a set of verdicts into per-bucket counts.
function tally(verdicts: readonly Verdict[]): {
  green: number;
  amber: number;
  red: number;
  unknown: number;
} {
  const c = { green: 0, amber: 0, red: 0, unknown: 0 };
  for (const v of verdicts) c[v] += 1;
  return c;
}

// Map the worst OBSERVED verdict to a headline bucket. Unknown rows are "not yet
// observed" (an unprovisioned / DevOps-gated pipe): they neither push the
// headline to at-risk nor hide a genuinely healthy board, so they are excluded
// from the worst-wins rollup here. This is a deliberate departure from
// worstVerdict's unknown-over-green ordering, appropriate for a leadership glance:
// only OBSERVED reds (stuck) and ambers (at risk) move the headline off healthy.
function headlineFor(verdict: Verdict): RollupHeadline {
  if (verdict === 'red') return 'stuck';
  if (verdict === 'amber') return 'at_risk';
  return 'healthy'; // green, or unknown (nothing observed => healthy-empty)
}

// Age of the oldest STUCK order. Stuck == order_verdict 'red' (an immediately-red
// signal or an SLO-breached hop, per design.md section 5). null-safe: orders with
// a null age are ignored; null when there are no red orders at all.
function oldestStuckAge(orders: readonly OrderHealth[]): number | null {
  let oldest: number | null = null;
  for (const o of orders) {
    if (o.order_verdict !== 'red') continue;
    const age = o.oldest_stuck_age_s;
    if (age === null) continue;
    oldest = oldest === null ? age : Math.max(oldest, age);
  }
  return oldest;
}

// The inventory_sync pipe's freshness as yes / no / unknown. true = fresh
// (green), false = stale (amber or red), null = unknown (no row, or the pipe's
// freshness is itself unknown / not yet provisioned).
function inventorySyncFresh(pipelines: readonly PipelineHealth[]): boolean | null {
  const inv = pipelines.find((p) => p.pipe === 'inventory_sync');
  if (inv === undefined || inv.freshness_verdict === 'unknown') return null;
  return inv.freshness_verdict === 'green';
}

// The rollup compute. Pure: same pipeline + order rows => same result. Derived
// only from the snapshot rows, so all reads are from the snapshot (no live call).
export function computeRollup(
  pipelines: readonly PipelineHealth[],
  orders: readonly OrderHealth[],
): LeadershipRollup {
  const pipeVerdicts = pipelines.map((p) => p.pipe_verdict);
  const orderVerdicts = orders.map((o) => o.order_verdict);

  // Worst-wins over OBSERVED verdicts only. worstVerdict over an empty set is
  // 'unknown' (the healthy-empty case), which maps to the 'healthy' bucket with
  // an 'unknown' chip so the strip discloses that nothing has been observed yet.
  const observed = [...pipeVerdicts, ...orderVerdicts].filter((v) => v !== 'unknown');
  const headlineVerdict = worstVerdict(observed);
  const headline = headlineFor(headlineVerdict);

  const pipeCounts = tally(pipeVerdicts);
  const orderCounts = tally(orderVerdicts);

  const counts: RollupCounts = {
    orders_total: orders.length,
    orders_green: orderCounts.green,
    orders_amber: orderCounts.amber,
    orders_red: orderCounts.red,
    orders_unknown: orderCounts.unknown,
    pipes_total: pipelines.length,
    pipes_green: pipeCounts.green,
    pipes_amber: pipeCounts.amber,
    pipes_red: pipeCounts.red,
    pipes_unknown: pipeCounts.unknown,
  };

  return {
    headline,
    headline_verdict: headlineVerdict,
    oldest_stuck_age_s: oldestStuckAge(orders),
    inventory_sync_fresh: inventorySyncFresh(pipelines),
    counts,
  };
}
