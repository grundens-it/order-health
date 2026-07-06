// Allocator monitor: the Warehouse Split three-verdict compute (Unit 4).
//
// This mirrors inventorySync.ts (the reference pipe). It is a PURE function of
// seeded inputs and thresholds (no I/O, no clock read beyond the injected
// nowMs), so every verdict boundary is unit-testable without a live middleware
// or NAV (design.md 5A.5, QA seat). writers.ts reads the (read-only, currently
// stubbed) allocation source, assembles AllocatorInput, and calls computeAllocator.
//
// The three INDEPENDENT verdicts (design.md 3.2 / 5, the "allocator: recent
// allocation error rate" signal, plus freshness + liveness):
//   1. freshness    - recency of the last split decision (wall-clock age) vs cycles.
//   2. liveness     - allocator service heartbeat age vs cycles, independent of #1.
//   3. split-sanity - rate of un-allocatable / failed splits in the window.
//                     Banded green/amber/red by failed_rate; NOT amber-capped, so a
//                     genuinely broken allocator (no ATP anywhere) can go RED.
import type {
  AllocationDecision,
  AllocatorDetail,
  AllocatorSplitSanity,
  Verdict,
} from '@order-health/shared';
import { worstVerdict } from '@order-health/shared';

export interface AllocatorThresholds {
  cycleSeconds: number;          // one allocator decision window (~5m)
  freshnessAmberCycles: number;
  freshnessRedCycles: number;
  livenessAmberCycles: number;
  livenessRedCycles: number;
  failedAmberRatio: number;      // (unallocatable + failed) / decisions above this => AMBER
  failedRedRatio: number;        // ...above this => RED
}

// Seeded, source-shaped inputs. Timestamps are ISO strings (or null when the
// source has not reported). decisions are most-recent-first.
export interface AllocatorInput {
  lastDecisionAt: string | null;      // recency of allocation decisions -> freshness
  serviceHeartbeatAt: string | null;  // allocator loop heartbeat -> liveness
  windowSeconds: number | null;       // the window the counts below cover
  decisionsWindow: number | null;     // total decisions counted in the window
  splitCount: number | null;          // multi-warehouse splits
  unallocatableCount: number | null;  // decisions with no ATP anywhere
  failedCount: number | null;         // errored decisions
  atpFallbackCount: number | null;    // inventory-aware fallbacks
  decisions: AllocationDecision[];    // recent split decisions, most-recent-first
}

export interface AllocatorResult {
  freshnessVerdict: Verdict;
  livenessVerdict: Verdict;
  sanityVerdict: Verdict;  // the third (split-sanity) sub-verdict
  pipeVerdict: Verdict;    // worst of the three
  decisionLagS: number | null;
  heartbeatAgeS: number | null;
  lastDecisionAt: string | null;
  heartbeatAt: string | null;
  detail: AllocatorDetail;
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

// A ratio-banded verdict: green under amberRatio, amber up to redRatio, red at
// or beyond redRatio. A null rate is 'unknown'.
function ratioBandVerdict(
  rate: number | null,
  amberRatio: number,
  redRatio: number,
): Verdict {
  if (rate === null) return 'unknown';
  if (rate >= redRatio) return 'red';
  if (rate >= amberRatio) return 'amber';
  return 'green';
}

// Split-sanity signal (the third verdict). Driven by the share of decisions the
// allocator could not satisfy (unallocatable) or that errored (failed) over the
// window. Structurally green/amber/red; not amber-capped.
function computeSanity(
  input: AllocatorInput,
  thresholds: AllocatorThresholds,
): AllocatorSplitSanity {
  const window = input.decisionsWindow;
  const unallocatable = input.unallocatableCount;
  const failed = input.failedCount;

  // Unknown only when we have no window to reason about.
  let failedRate: number | null = null;
  let splitRate: number | null = null;
  if (window !== null) {
    const denom = Math.max(window, 1);
    failedRate = ((unallocatable ?? 0) + (failed ?? 0)) / denom;
    splitRate = input.splitCount !== null ? input.splitCount / denom : null;
  }

  const verdict = ratioBandVerdict(
    failedRate,
    thresholds.failedAmberRatio,
    thresholds.failedRedRatio,
  );

  return {
    decisions_window: window,
    split_count: input.splitCount,
    split_rate: splitRate,
    unallocatable_count: unallocatable,
    failed_count: failed,
    failed_rate: failedRate,
    atp_fallback_count: input.atpFallbackCount,
    sanity_verdict: verdict,
  };
}

// The three-verdict compute. Pure: same inputs + thresholds + nowMs => same
// result. Modelled on computeInventorySync.
export function computeAllocator(
  input: AllocatorInput,
  thresholds: AllocatorThresholds,
  nowMs: number,
): AllocatorResult {
  const decisionLagS = ageSeconds(input.lastDecisionAt, nowMs);
  const heartbeatAgeS = ageSeconds(input.serviceHeartbeatAt, nowMs);

  const freshnessVerdict = cycleBandVerdict(
    decisionLagS,
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

  const sanity = computeSanity(input, thresholds);
  const sanityVerdict = sanity.sanity_verdict;

  const detail: AllocatorDetail = {
    window_seconds: input.windowSeconds,
    last_decision_at: input.lastDecisionAt,
    recent_decisions: input.decisions,
    sanity,
  };

  // Rollup = worst of the three independent verdicts.
  const pipeVerdict = worstVerdict([freshnessVerdict, livenessVerdict, sanityVerdict]);

  return {
    freshnessVerdict,
    livenessVerdict,
    sanityVerdict,
    pipeVerdict,
    decisionLagS,
    heartbeatAgeS,
    lastDecisionAt: input.lastDecisionAt,
    heartbeatAt: input.serviceHeartbeatAt,
    detail,
  };
}
