// Forward Sync Monitor: the two-verdict compute (forward-sync-pipe.md section 6,
// ADR-0006 phase 1).
//
// This surfaces the 2026-07-01 failure: Shopify DTC orders the middleware tagged
// as exported (1-Status:Shopify-Exported! / 1-Middleware Status!) whose NAV Sales
// Order create never committed, so they exist nowhere in NAV. Phase 1 derives the
// backlog read-only from GRUS$Sales Header Staging using CreatedDate as the age
// clock (ADR-0006). Like inventorySync.ts this is a PURE function of seeded inputs
// and thresholds (no I/O, no clock read beyond the injected nowMs), so every
// verdict boundary is unit-testable without a live NAV or middleware. writers.ts
// reads the (read-only) sources, assembles ForwardSyncInput, and calls
// computeForwardSync here.
//
// The two INDEPENDENT verdicts:
//   1. freshness (backlog) - exported orders absent from NAV, past grace, after
//      the date floor. Age-banded AND count-banded, floored at AMBER once a real
//      stuck order exists (a stuck order is never GREEN, US-2/US-3). Allowed to
//      reach RED (a real backlog, unlike inventory divergence).
//   2. liveness (export) - wall-clock age of the last successful import. null
//      source reads 'unknown', never RED (US-6).
import type {
  ForwardSyncCoverage,
  ForwardSyncDetail,
  ForwardSyncSampleOrder,
  ForwardSyncTag,
  Verdict,
} from '@order-health/shared';
import { worstVerdict } from '@order-health/shared';

// Matches config.forwardSync EXACTLY so writers.ts passes config.forwardSync
// straight in. Minutes/counts, not cycles.
export interface ForwardSyncThresholds {
  graceMinutes: number;
  backlogAmberMinutes: number;
  backlogRedMinutes: number;
  backlogAmberCount: number;
  backlogRedCount: number;
  livenessAmberMinutes: number;
  livenessRedMinutes: number;
  dateFloorIso: string; // '' => no floor
}

// One exported-pending candidate order (assembled by the writer from the NAV
// staging read). shopifyNumber is the <n> correlation key (never the leg).
export interface ForwardSyncCandidate {
  shopifyOrderName: string | null; // 'SP-319121'
  shopifyNumber: string;           // '319121'
  createdAt: string | null;        // CreatedDate ISO (age clock)
  tag: ForwardSyncTag;
}

// Seeded, source-shaped inputs. Timestamps are ISO strings (or null when a source
// has not reported). navPresent is the set of Shopify numbers present in NAV;
// correlation is on the bare <n>, never the multi-leg SP-<n>-<leg>.
export interface ForwardSyncInput {
  candidates: ForwardSyncCandidate[];
  navPresent: ReadonlySet<string>; // Shopify numbers present in NAV (correlation on <n>)
  lastSuccessAt: string | null;    // export-liveness source; null => unknown
  coverage: ForwardSyncCoverage;   // 'staging' in phase 1
  sourced: boolean;                // false => candidate source not wired (US-7 unknown-not-green)
}

export interface ForwardSyncResult {
  freshnessVerdict: Verdict; // the backlog verdict (exported-not-in-NAV staleness)
  livenessVerdict: Verdict;  // the export-liveness verdict
  pipeVerdict: Verdict;      // worst of the two
  oldestAgeS: number | null; // mirrors detail.oldest_age_s (writer maps to watermark_lag_s)
  lastSuccessAt: string | null;
  lastSuccessAgeS: number | null;
  detail: ForwardSyncDetail;
}

// Age in seconds of an ISO timestamp relative to nowMs. null-safe: null when iso
// is null or unparseable, else max(0, round((nowMs - t) / 1000)).
function ageSeconds(iso: string | null, nowMs: number): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

// A minute-banded verdict: green under amberMinutes, amber up to redMinutes, red
// at or beyond redMinutes. A null age is 'unknown' (source not yet reporting).
function minuteBandVerdict(
  ageS: number | null,
  amberMinutes: number,
  redMinutes: number,
): Verdict {
  if (ageS === null) return 'unknown';
  if (ageS >= redMinutes * 60) return 'red';
  if (ageS >= amberMinutes * 60) return 'amber';
  return 'green';
}

// One in-backlog candidate carried with its computed age (seconds). Only orders
// that survive the backlog filter reach this shape.
interface BacklogEntry {
  candidate: ForwardSyncCandidate;
  ageS: number;
}

// The backlog filter (forward-sync-pipe.md 6, US-1/US-2/US-8). A candidate is IN
// the backlog only when ALL hold:
//   1. It is absent from NAV. Correlation is on the bare <n>, never the multi-leg
//      SP-<n>-<leg>, so an order present via ANY leg counts as present (US-1).
//   2. Its createdAt is non-null and parseable. A candidate with no age clock
//      cannot be proven past grace, so it is excluded (it would otherwise count as
//      a zero-age order that never crosses the grace window anyway).
//   3. If a dateFloorIso is set, createdAt is at or after it. Orders before the
//      NAV cutover are excluded so the pipe does not boot RED on the historical
//      May cluster / stale tag lint (US-8). Compared by Date.parse to be robust.
//   4. Its age is at or past the grace window. Younger orders are still plausibly
//      in-flight and are suppressed (US-2).
function buildBacklog(
  input: ForwardSyncInput,
  thresholds: ForwardSyncThresholds,
  nowMs: number,
): BacklogEntry[] {
  const graceS = thresholds.graceMinutes * 60;
  const floorMs =
    thresholds.dateFloorIso !== '' ? Date.parse(thresholds.dateFloorIso) : Number.NaN;
  const hasFloor = !Number.isNaN(floorMs);

  const backlog: BacklogEntry[] = [];
  for (const candidate of input.candidates) {
    // 1. present in NAV via any leg => not stuck.
    if (input.navPresent.has(candidate.shopifyNumber)) continue;

    // 2. no parseable age clock => cannot prove past grace, exclude.
    if (candidate.createdAt === null) continue;
    const createdMs = Date.parse(candidate.createdAt);
    if (Number.isNaN(createdMs)) continue;

    // 3. before the date floor => excluded (historical cutover).
    if (hasFloor && createdMs < floorMs) continue;

    // 4. past the grace window.
    const ageS = Math.max(0, Math.round((nowMs - createdMs) / 1000));
    if (ageS < graceS) continue;

    backlog.push({ candidate, ageS });
  }
  return backlog;
}

// The two-verdict compute. Pure: same inputs + thresholds + nowMs => same result.
export function computeForwardSync(
  input: ForwardSyncInput,
  thresholds: ForwardSyncThresholds,
  nowMs: number,
): ForwardSyncResult {
  const backlog = buildBacklog(input, thresholds, nowMs);

  // Ages present in the backlog (seconds). Oldest = max age, newest = min age.
  const ages = backlog.map((b) => b.ageS);
  const oldestAgeS = ages.length > 0 ? Math.max(...ages) : null;
  const newestAgeS = ages.length > 0 ? Math.min(...ages) : null;

  // Backlog (freshness) verdict.
  let freshnessVerdict: Verdict;
  if (!input.sourced) {
    // A blind source is never GREEN: we cannot claim "no backlog" if the source
    // that would find it is not wired (US-7, unknown-not-green).
    freshnessVerdict = 'unknown';
  } else if (backlog.length === 0) {
    freshnessVerdict = 'green';
  } else {
    // Escalate by the worse of an age band (on the OLDEST order) and a count band.
    const ageBand = minuteBandVerdict(
      oldestAgeS,
      thresholds.backlogAmberMinutes,
      thresholds.backlogRedMinutes,
    );
    const countBand: Verdict =
      backlog.length >= thresholds.backlogRedCount
        ? 'red'
        : backlog.length >= thresholds.backlogAmberCount
          ? 'amber'
          : 'green';
    let verdict = worstVerdict([ageBand, countBand]);
    // Count floor: a real stuck order (past grace, absent from NAV) is never GREEN,
    // even if it is younger than the amber age band (US-2/US-3).
    if (backlog.length >= 1) verdict = worstVerdict([verdict, 'amber']);
    freshnessVerdict = verdict;
  }

  // Export-liveness verdict. null last_success_at => 'unknown', never RED (US-6).
  const lastSuccessAgeS = ageSeconds(input.lastSuccessAt, nowMs);
  const livenessVerdict = minuteBandVerdict(
    lastSuccessAgeS,
    thresholds.livenessAmberMinutes,
    thresholds.livenessRedMinutes,
  );

  const pipeVerdict = worstVerdict([freshnessVerdict, livenessVerdict]);

  // contiguous_block: the "export stalled for a window" fingerprint of the
  // 2026-07-01 incident (SP-319121..SP-319156). True iff the source is wired AND
  // at least backlogRedCount orders sit in the backlog AND their created-at span
  // (oldest age minus newest age) fits inside ONE grace window. The grace window
  // is the tightness threshold because a cluster stalled inside a single grace
  // interval is one stalled export batch, not orders trickling in over hours.
  const spanS = oldestAgeS !== null && newestAgeS !== null ? oldestAgeS - newestAgeS : null;
  const contiguousBlock =
    input.sourced &&
    backlog.length >= thresholds.backlogRedCount &&
    spanS !== null &&
    spanS <= thresholds.graceMinutes * 60;

  // Sample: oldest-first (largest age first), capped at 25 for the panel table.
  const sample: ForwardSyncSampleOrder[] = backlog
    .slice()
    .sort((a, b) => b.ageS - a.ageS)
    .slice(0, 25)
    .map((b) => ({
      shopify_order_name: b.candidate.shopifyOrderName,
      age_s: b.ageS,
      tag: b.candidate.tag,
    }));

  const detail: ForwardSyncDetail = {
    backlog_count: backlog.length,
    oldest_age_s: oldestAgeS,
    newest_age_s: newestAgeS,
    last_success_at: input.lastSuccessAt,
    contiguous_block: contiguousBlock,
    coverage: input.coverage,
    sample,
  };

  return {
    freshnessVerdict,
    livenessVerdict,
    pipeVerdict,
    oldestAgeS,
    lastSuccessAt: input.lastSuccessAt,
    lastSuccessAgeS,
    detail,
  };
}
