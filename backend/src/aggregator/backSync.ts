// Back-sync Monitor: the three-verdict compute (Unit 2, design.md 3.2 / 5).
//
// This mirrors inventorySync.ts: a PURE function of seeded inputs and thresholds
// (no I/O, no clock read beyond the injected nowMs), so every verdict boundary is
// unit-testable without a live NAV or middleware. writers.ts reads the (read-only,
// currently stubbed) sources, assembles BackSyncInput, and calls computeBackSync.
//
// The back-sync pipe is NAV shipment (3PL shipped) -> Shopify fulfillmentCreate.
// The three INDEPENDENT verdicts:
//   1. freshness - age of the last successful back-sync (fulfillmentCreate) vs cycles.
//   2. liveness  - back-sync watcher heartbeat age vs cycles, independent of freshness.
//   3. missed    - count of NAV shipments posted with no Shopify fulfillment. Unlike
//                  inventory-sync's amber-capped divergence, this is a REAL backlog
//                  and is allowed to reach RED (design.md 5 "Missed back-sync ... RED").
import type { BackSyncDetail, MissedShipment, Verdict } from '@order-health/shared';
import { worstVerdict } from '@order-health/shared';

export interface BackSyncThresholds {
  cycleSeconds: number;
  freshnessAmberCycles: number;
  freshnessRedCycles: number;
  livenessAmberCycles: number;
  livenessRedCycles: number;
  missedWindowDays: number;
  missedAmberCount: number;
  missedRedCount: number;
}

// Seeded, source-shaped inputs. Timestamps are ISO strings (or null when a source
// has not reported). missedShipments is null when the endpoint was not queried
// (stub) so the missed signal reads 'unknown' rather than a false green; an empty
// array means queried and found none (a genuine green).
export interface BackSyncInput {
  lastBackSyncAt: string | null;          // watermark: last successful fulfillmentCreate
  watcherHeartbeatAt: string | null;      // back-sync watcher heartbeat
  fulfillmentsLast24h: number | null;
  errorsLast24h: number | null;
  missedShipments: MissedShipment[] | null;
}

export interface BackSyncResult {
  freshnessVerdict: Verdict;
  livenessVerdict: Verdict;
  missedVerdict: Verdict;   // the third (missed-shipments) sub-verdict, NOT capped
  pipeVerdict: Verdict;     // worst of the three
  watermarkLagS: number | null;
  heartbeatAgeS: number | null;
  lastProgressAt: string | null;
  heartbeatAt: string | null;
  detail: BackSyncDetail;
}

// Age in seconds of an ISO timestamp relative to nowMs. null-safe.
function ageSeconds(iso: string | null, nowMs: number): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

// A cycle-banded verdict: green under amberCycles, amber up to redCycles, red at
// or beyond redCycles. A null age is 'unknown' (source not yet reporting).
function cycleBandVerdict(
  ageS: number | null,
  cycleSeconds: number,
  amberCycles: number,
  redCycles: number,
): Verdict {
  if (ageS === null) return 'unknown';
  if (ageS >= redCycles * cycleSeconds) return 'red';
  if (ageS >= amberCycles * cycleSeconds) return 'amber';
  return 'green';
}

// The missed-shipments signal (design.md 5 "Missed back-sync"). Count-banded:
// green at zero, amber at amberCount, red at redCount. NOT capped: a cluster of
// missed shipments is a real backlog and reds the pipe (the deliberate contrast
// with inventory-sync's amber-never-red divergence). null count => unknown.
export function missedCountVerdict(
  count: number | null,
  amberCount: number,
  redCount: number,
): Verdict {
  if (count === null) return 'unknown';
  if (count >= redCount) return 'red';
  if (count >= amberCount) return 'amber';
  return 'green';
}

// The three-verdict compute. Pure: same inputs + thresholds + nowMs => same result.
export function computeBackSync(
  input: BackSyncInput,
  thresholds: BackSyncThresholds,
  nowMs: number,
): BackSyncResult {
  const watermarkLagS = ageSeconds(input.lastBackSyncAt, nowMs);
  const heartbeatAgeS = ageSeconds(input.watcherHeartbeatAt, nowMs);

  const freshnessVerdict = cycleBandVerdict(
    watermarkLagS,
    thresholds.cycleSeconds,
    thresholds.freshnessAmberCycles,
    thresholds.freshnessRedCycles,
  );

  const livenessVerdict = cycleBandVerdict(
    heartbeatAgeS,
    thresholds.cycleSeconds,
    thresholds.livenessAmberCycles,
    thresholds.livenessRedCycles,
  );

  const missedShipments = input.missedShipments ?? [];
  const missedCount = input.missedShipments === null ? null : missedShipments.length;
  const missedVerdict = missedCountVerdict(
    missedCount,
    thresholds.missedAmberCount,
    thresholds.missedRedCount,
  );

  const detail: BackSyncDetail = {
    last_back_sync_at: input.lastBackSyncAt,
    missed_verdict: missedVerdict,
    missed_count: missedCount ?? 0,
    missed_window_days: thresholds.missedWindowDays,
    fulfillments_last_24h: input.fulfillmentsLast24h,
    errors_last_24h: input.errorsLast24h,
    missed_shipments: missedShipments,
  };

  // Rollup = worst of the three. The missed signal is uncapped, so a real backlog
  // can push the pipe to RED (unlike inventory-sync's divergence).
  const pipeVerdict = worstVerdict([freshnessVerdict, livenessVerdict, missedVerdict]);

  return {
    freshnessVerdict,
    livenessVerdict,
    missedVerdict,
    pipeVerdict,
    watermarkLagS,
    heartbeatAgeS,
    lastProgressAt: input.lastBackSyncAt,
    heartbeatAt: input.watcherHeartbeatAt,
    detail,
  };
}
