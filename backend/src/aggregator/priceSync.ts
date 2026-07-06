// Price Sync Monitor: freshness + liveness, cycle-banded (design.md 3 line 82,
// "price-sync: same freshness shape" as inventory-sync).
//
// Two INDEPENDENT verdicts, mirroring inventorySync.ts:
//   1. freshness - age of the last price-sync signal RECEIVED (is new price data
//                  flowing in) vs cycles.
//   2. liveness  - age of the last price-sync RUN / loop (is the syncer alive)
//                  vs cycles, independent of freshness.
//
// PURE: no I/O, no clock read beyond the injected nowMs, so every verdict
// boundary is unit-testable without a live middleware or NAV.
import type { PriceSyncDetail, Verdict } from '@order-health/shared';
import { worstVerdict } from '@order-health/shared';

export interface PriceSyncThresholds {
  cycleSeconds: number;
  freshnessAmberCycles: number;
  freshnessRedCycles: number;
  livenessAmberCycles: number;
  livenessRedCycles: number;
}

// Seeded, source-shaped input. Timestamps are ISO strings (or null when the
// source has not reported).
export interface PriceSyncInput {
  lastReceivedAt: string | null; // last price-sync signal received (freshness)
  lastRunAt: string | null;      // last price-sync run/loop completed (liveness)
}

export interface PriceSyncResult {
  freshnessVerdict: Verdict;
  livenessVerdict: Verdict;
  pipeVerdict: Verdict; // worst of the two
  lastReceivedAgeS: number | null;
  lastRunAgeS: number | null;
  lastReceivedAt: string | null;
  lastRunAt: string | null;
  detail: PriceSyncDetail;
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
export function cycleBandVerdict(
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

// The two-verdict compute. Pure: same inputs + thresholds + nowMs => same result.
export function computePriceSync(
  input: PriceSyncInput,
  thresholds: PriceSyncThresholds,
  nowMs: number,
): PriceSyncResult {
  const lastReceivedAgeS = ageSeconds(input.lastReceivedAt, nowMs);
  const lastRunAgeS = ageSeconds(input.lastRunAt, nowMs);

  const freshnessVerdict = cycleBandVerdict(
    lastReceivedAgeS,
    thresholds.cycleSeconds,
    thresholds.freshnessAmberCycles,
    thresholds.freshnessRedCycles,
  );

  const livenessVerdict = cycleBandVerdict(
    lastRunAgeS,
    thresholds.cycleSeconds,
    thresholds.livenessAmberCycles,
    thresholds.livenessRedCycles,
  );

  const detail: PriceSyncDetail = {
    last_received_at: input.lastReceivedAt,
    last_received_age_s: lastReceivedAgeS,
    last_run_at: input.lastRunAt,
    last_run_age_s: lastRunAgeS,
  };

  return {
    freshnessVerdict,
    livenessVerdict,
    pipeVerdict: worstVerdict([freshnessVerdict, livenessVerdict]),
    lastReceivedAgeS,
    lastRunAgeS,
    lastReceivedAt: input.lastReceivedAt,
    lastRunAt: input.lastRunAt,
    detail,
  };
}
