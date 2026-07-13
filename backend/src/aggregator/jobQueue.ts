// NAV Job Queue Monitor: COMPUTE the verdict from read-only NAV (Unit 1, ADR-0007).
//
// This unit replaces the old "adopt the middleware verdict" behaviour. The live
// run on 2026-07-13 showed why: the middleware returned level:"Stuck" for a normal
// 53-min IABC run (a legitimate 20 to 47 min job), our map did not recognise it,
// and the pipe flipped to 'unknown' while NAV showed auto-release firing 4.5 min
// prior. Separately its stuck-staging endpoint reported 1,988 while its job-queue
// endpoint reported pending_staging=0 for the same instant. The middleware graded
// itself and got it wrong.
//
// So the verdict is now three INDEPENDENT sub-verdicts computed from read-only NAV:
//   1. liveness  - recency of the last CU 50009 auto-release firing.
//   2. stuck-job - the oldest IN-PROCESS CU 50007 run. A normal IABC run is 20 to
//                  47 min, so this only ambers/reds past a REAL threshold (~60 min);
//                  it never flags a normal long run.
//   3. staging   - the count of REAL Status = 0 pending-promotion staging rows
//                  (NOT the old Status = 1 "Not Auto-released" rows).
// The middleware's own level and stuck-staging count are kept only as a labelled
// CROSS-CHECK in the detail bag, never as the verdict.
//
// PURE: same inputs + nowMs => same result (no I/O, no clock read beyond nowMs),
// so every band is unit-testable without a live NAV or middleware.
import type { JobQueueDetail, Verdict } from '@order-health/shared';
import { worstVerdict } from '@order-health/shared';

export interface JobQueueThresholds {
  autoReleaseAmberSeconds: number;   // last CU 50009 auto-release age >= this => AMBER
  autoReleaseRedSeconds: number;     // ...>= this => RED
  inProcessAmberSeconds: number;     // oldest in-process CU 50007 age >= this => AMBER (>= ~60 min)
  inProcessRedSeconds: number;       // ...>= this => RED
  pendingStagingAmberCount: number;  // real Status=0 pending-promotion rows >= this => AMBER
  pendingStagingRedCount: number;    // ...>= this => RED
  stuckJobWarnSeconds: number;       // legacy: labels the middleware cross-check only
}

// Seeded, source-shaped input. The NAV fields are authoritative; the middleware
// fields are the monitored cross-check (never gate the verdict).
export interface JobQueueInput {
  // NAV (authoritative).
  autoReleaseFiredAt: string | null;   // last CU 50009 auto-release firing
  oldestInProcessJobAt: string | null; // start time of the oldest in-process CU 50007 run
  inProcessJobCount: number | null;    // CU 50007 rows In Process (null = unread => unknown)
  pendingStagingCount: number | null;  // real Status=0 pending-promotion rows (null = unread)
  // Middleware cross-check (monitored, NOT authoritative).
  middlewareVerdict: string | null;         // the raw level the endpoint returned
  middlewareStuckStagingCount: number | null; // the endpoint's own stuck-staging count
  stuckJobCount: number | null;             // jobs the middleware flags stuck
  checkedAt: string | null;                 // when the middleware computed its view
}

export interface JobQueueResult {
  pipeVerdict: Verdict;       // worst of the three NAV sub-verdicts
  livenessVerdict: Verdict;
  stuckJobVerdict: Verdict;
  stagingVerdict: Verdict;
  lastProgressAt: string | null;
  heartbeatAt: string | null;
  detail: JobQueueDetail;
}

// Age in seconds of an ISO timestamp relative to nowMs. null-safe.
function ageSeconds(iso: string | null, nowMs: number): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

// A seconds-banded verdict: green under amber, amber up to red, red at or beyond
// red. A null age is 'unknown' (source not reporting).
function secondsBandVerdict(ageS: number | null, amberS: number, redS: number): Verdict {
  if (ageS === null) return 'unknown';
  if (ageS >= redS) return 'red';
  if (ageS >= amberS) return 'amber';
  return 'green';
}

// A count-banded verdict: green under amber, amber up to red, red at or beyond
// red. A null count is 'unknown' (source not reporting).
function countBandVerdict(count: number | null, amberCount: number, redCount: number): Verdict {
  if (count === null) return 'unknown';
  if (count >= redCount) return 'red';
  if (count >= amberCount) return 'amber';
  return 'green';
}

// Normalize the middleware's raw level to a Verdict for the CROSS-CHECK only (so
// the panel can show whether the actor agrees). This does NOT drive the verdict.
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
    case 'stuck':
      return 'red';
    default:
      return 'unknown';
  }
}

// The stuck-job sub-verdict. An unread source (inProcessJobCount null) is unknown;
// a genuine "no in-process job" (count 0) is GREEN (nothing can be stuck); with
// jobs in process, band the oldest one's age. This is what stops a normal long
// IABC run from reading stuck: under the ~60 min threshold it stays green.
function stuckJobVerdict(input: JobQueueInput, t: JobQueueThresholds, nowMs: number): Verdict {
  if (input.inProcessJobCount === null) return 'unknown';
  if (input.inProcessJobCount === 0) return 'green';
  return secondsBandVerdict(
    ageSeconds(input.oldestInProcessJobAt, nowMs),
    t.inProcessAmberSeconds,
    t.inProcessRedSeconds,
  );
}

// The compute. Three NAV sub-verdicts; the middleware is a labelled cross-check.
export function computeJobQueue(
  input: JobQueueInput,
  thresholds: JobQueueThresholds,
  nowMs: number,
): JobQueueResult {
  const autoReleaseAgeS = ageSeconds(input.autoReleaseFiredAt, nowMs);

  const livenessVerdict = secondsBandVerdict(
    autoReleaseAgeS,
    thresholds.autoReleaseAmberSeconds,
    thresholds.autoReleaseRedSeconds,
  );

  const stuckVerdict = stuckJobVerdict(input, thresholds, nowMs);

  const stagingVerdict = countBandVerdict(
    input.pendingStagingCount,
    thresholds.pendingStagingAmberCount,
    thresholds.pendingStagingRedCount,
  );

  // Reference the legacy label so it stays part of the record's meaning.
  void thresholds.stuckJobWarnSeconds;

  const detail: JobQueueDetail = {
    source: 'nav:job-queue-log+staging',
    liveness_verdict: livenessVerdict,
    stuck_job_verdict: stuckVerdict,
    staging_verdict: stagingVerdict,
    auto_release_fired_at: input.autoReleaseFiredAt,
    auto_release_age_s: autoReleaseAgeS,
    longest_running_job_s: ageSeconds(input.oldestInProcessJobAt, nowMs),
    in_process_job_count: input.inProcessJobCount,
    pending_staging_count: input.pendingStagingCount,
    // Cross-check: the actor's own claim, surfaced but not adopted.
    middleware_verdict_raw: input.middlewareVerdict,
    middleware_stuck_staging_count: input.middlewareStuckStagingCount,
    stuck_job_count: input.stuckJobCount,
    checked_at: input.checkedAt,
  };

  const pipeVerdict = worstVerdict([livenessVerdict, stuckVerdict, stagingVerdict]);

  return {
    pipeVerdict,
    livenessVerdict,
    stuckJobVerdict: stuckVerdict,
    stagingVerdict,
    lastProgressAt: input.autoReleaseFiredAt, // last CU 50009 auto-release firing
    heartbeatAt: input.checkedAt,
    detail,
  };
}
