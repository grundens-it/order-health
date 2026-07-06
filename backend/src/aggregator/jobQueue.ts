// NAV Job Queue Monitor: CONSUME the middleware verdict, do not recompute it.
//
// Design rule (design.md 5 line 126 and section 6): the middleware ALREADY
// computes NAV job-queue health (the CU 50009 auto-release + no-stuck-job
// tripwire). This unit promotes that verdict into the rollup rather than
// re-deriving it. So this "compute" is deliberately NOT a verdict calculation:
// it normalizes and ADOPTS the middleware's verdict unchanged, and carries the
// supporting numbers into a typed detail bag for the panel. There is no cycle
// banding here on purpose; re-deriving job-queue health would duplicate (and
// risk diverging from) the source of truth.
//
// PURE: same inputs + nowMs => same result (no I/O, no clock read beyond nowMs),
// so the passthrough is unit-testable without a live middleware.
import type { JobQueueDetail, Verdict } from '@order-health/shared';

export interface JobQueueThresholds {
  // No verdict band lives here (the verdict is adopted, not computed). This knob
  // only documents the stuck-job age the middleware itself trips on, so the
  // panel can label the supporting number. It never re-derives the verdict.
  stuckJobWarnSeconds: number;
}

// Seeded, source-shaped input: exactly what the middleware job-queue/health
// endpoint exposes read-only. middlewareVerdict is the endpoint's OWN verdict.
export interface JobQueueInput {
  middlewareVerdict: string | null;   // the verdict the middleware already computed
  autoReleaseFiredAt: string | null;  // last CU 50009 auto-release firing
  longestRunningJobS: number | null;  // age of the oldest running Job Queue Entry
  stuckJobCount: number | null;       // jobs the middleware flags stuck
  checkedAt: string | null;           // when the middleware computed this
}

export interface JobQueueResult {
  pipeVerdict: Verdict;   // == the adopted middleware verdict (NOT recomputed)
  adoptedVerdict: Verdict;
  lastProgressAt: string | null;
  detail: JobQueueDetail;
}

// Age in seconds of an ISO timestamp relative to nowMs. null-safe.
function ageSeconds(iso: string | null, nowMs: number): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

// Normalize the middleware's verdict string to our Verdict enum WITHOUT changing
// its meaning. This is a label map, not a re-derivation: green/amber/red pass
// straight through, common synonyms map to the same class, anything else (or a
// missing verdict) is 'unknown'. The middleware remains the source of truth.
export function adoptMiddlewareVerdict(raw: string | null): Verdict {
  if (raw === null) return 'unknown';
  switch (raw.trim().toLowerCase()) {
    case 'green':
    case 'ok':
    case 'healthy':
      return 'green';
    case 'amber':
    case 'warn':
    case 'warning':
    case 'degraded':
      return 'amber';
    case 'red':
    case 'critical':
    case 'down':
    case 'unhealthy':
      return 'red';
    default:
      return 'unknown';
  }
}

// The consume (not recompute) step. pipeVerdict is exactly the adopted verdict.
export function computeJobQueue(
  input: JobQueueInput,
  thresholds: JobQueueThresholds,
  nowMs: number,
): JobQueueResult {
  const adoptedVerdict = adoptMiddlewareVerdict(input.middlewareVerdict);

  const detail: JobQueueDetail = {
    source: 'middleware:job-queue/health',
    adopted_verdict: adoptedVerdict,
    middleware_verdict_raw: input.middlewareVerdict,
    auto_release_fired_at: input.autoReleaseFiredAt,
    auto_release_age_s: ageSeconds(input.autoReleaseFiredAt, nowMs),
    // Surfaced only for context; the middleware, not this line, owns the tripwire
    // (stuckJobWarnSeconds documents the source threshold, it does not gate here).
    longest_running_job_s: input.longestRunningJobS,
    stuck_job_count: input.stuckJobCount,
    checked_at: input.checkedAt,
  };
  // Reference the knob so the source threshold is part of the record's meaning
  // without re-deriving the verdict from it.
  void thresholds.stuckJobWarnSeconds;

  return {
    // Adopted, NOT recomputed. Whatever the middleware said, we surface.
    pipeVerdict: adoptedVerdict,
    adoptedVerdict,
    lastProgressAt: input.autoReleaseFiredAt,
    detail,
  };
}
