// Inventory Sync Monitor: the three-verdict compute (design.md 5A).
//
// This is the REFERENCE pipe compute. It is a PURE function of seeded inputs and
// thresholds (no I/O, no clock read beyond the injected nowMs), so every verdict
// boundary is unit-testable without a live NAV or middleware (design.md 5A.5, QA
// seat). writers.ts reads the (read-only, currently stubbed) sources, assembles
// InventorySyncInput, and calls computeInventorySync here.
//
// The three INDEPENDENT verdicts (design.md 5A.1):
//   1. freshness  - watermark lag (wall-clock age of last progress) vs cycles.
//   2. liveness   - watcher heartbeat age vs cycles, independent of freshness.
//   3. divergence - dry-run vs live push (push-outcome sanity). AMBER-capped,
//                   NEVER auto-red (design.md 5A.3, the "7,245 question").
import type {
  InventoryDivergence,
  InventorySyncDetail,
  InventoryWalk,
  Verdict,
} from '@order-health/shared';
import { worstVerdict } from '@order-health/shared';

export interface InventorySyncThresholds {
  cycleSeconds: number;
  freshnessAmberCycles: number;
  freshnessRedCycles: number;
  livenessAmberCycles: number;
  livenessRedCycles: number;
  divergenceAmberRatio: number;
}

// Seeded, source-shaped inputs. Timestamps are ISO strings (or null when a
// source has not reported). walks are most-recent-first.
export interface InventorySyncInput {
  navNewestIabcEntryNo: number | null;
  watermarkEntryNo: number | null;
  lastWalkAt: string | null;
  watcherHeartbeatAt: string | null;
  walks: InventoryWalk[];
  dryRunWouldPush: number | null;
  dryRunAt: string | null;
  totalPairs: number | null;
}

export interface InventorySyncResult {
  freshnessVerdict: Verdict;
  livenessVerdict: Verdict;
  divergenceVerdict: Verdict; // the third (push-outcome) sub-verdict
  pipeVerdict: Verdict;       // worst of the three, with the amber cap enforced
  watermarkLagS: number | null;
  heartbeatAgeS: number | null;
  lastProgressAt: string | null;
  heartbeatAt: string | null;
  detail: InventorySyncDetail;
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

// The amber cap (design.md 5A.3). A verdict that would be RED is pulled back to
// AMBER. This is what makes the dry-run divergence structurally unable to push
// the pipe past amber by itself, no matter how large the divergence is.
export function capAmberNeverRed(v: Verdict): Verdict {
  return v === 'red' ? 'amber' : v;
}

// Trailing MAX pushed across recent live walks (design.md 5A.2 "trailing max").
function livePushTrailing(walks: InventoryWalk[]): number | null {
  if (walks.length === 0) return null;
  return walks.reduce((max, w) => Math.max(max, w.pushed), 0);
}

// Push-outcome sanity (the third verdict). Driven by the dry-run vs live-push
// divergence ratio and by the onboarding "untracked" signal. Structurally green
// or amber only; capAmberNeverRed is applied for defence in depth.
function computeDivergence(
  input: InventorySyncInput,
  walks: InventoryWalk[],
  divergenceAmberRatio: number,
): InventoryDivergence {
  const liveTrailing = livePushTrailing(walks);
  const would = input.dryRunWouldPush;

  let ratio: number | null = null;
  if (would !== null) {
    ratio = would / Math.max(liveTrailing ?? 0, 1);
  }

  const latestUntracked = walks[0]?.untracked_filtered ?? 0;

  // Unknown only when we have neither a dry-run nor any walk to reason about.
  let verdict: Verdict;
  if (would === null && walks.length === 0) {
    verdict = 'unknown';
  } else {
    const divergent = ratio !== null && ratio > divergenceAmberRatio;
    const onboardingSignal = latestUntracked > 0;
    verdict = divergent || onboardingSignal ? 'amber' : 'green';
  }

  return {
    dryrun_would_push: would,
    dryrun_at: input.dryRunAt,
    total_pairs: input.totalPairs,
    live_push_trailing: liveTrailing,
    ratio,
    // Enforced twice: computed as green/amber above, and capped here so a future
    // edit that lets red leak in still cannot escalate the divergence past amber.
    divergence_verdict: capAmberNeverRed(verdict),
  };
}

// The three-verdict compute. Pure: same inputs + thresholds + nowMs => same
// result. This is the seam Units 2 to 6 copy for their own pipe.
export function computeInventorySync(
  input: InventorySyncInput,
  thresholds: InventorySyncThresholds,
  nowMs: number,
): InventorySyncResult {
  const watermarkLagS = ageSeconds(input.lastWalkAt, nowMs);
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

  const divergence = computeDivergence(input, input.walks, thresholds.divergenceAmberRatio);
  const divergenceVerdict = divergence.divergence_verdict; // already amber-capped

  const entryGap =
    input.navNewestIabcEntryNo !== null && input.watermarkEntryNo !== null
      ? input.navNewestIabcEntryNo - input.watermarkEntryNo
      : null;

  const detail: InventorySyncDetail = {
    trigger_mode: 'job_queue',
    watermark_entry_no: input.watermarkEntryNo,
    nav_newest_iabc_entry_no: input.navNewestIabcEntryNo,
    watermark_entry_gap: entryGap,
    last_walk: input.walks[0] ?? null,
    recent_walks: input.walks,
    divergence,
  };

  // Rollup = worst of the three. divergenceVerdict is amber-capped, so the
  // dry-run divergence can never by itself push the pipe to RED (design.md 5A.3).
  const pipeVerdict = worstVerdict([
    freshnessVerdict,
    livenessVerdict,
    capAmberNeverRed(divergenceVerdict),
  ]);

  return {
    freshnessVerdict,
    livenessVerdict,
    divergenceVerdict,
    pipeVerdict,
    watermarkLagS,
    heartbeatAgeS,
    lastProgressAt: input.lastWalkAt,
    heartbeatAt: input.watcherHeartbeatAt,
    detail,
  };
}
