// Verdict-correctness tests for the NAV Job Queue Monitor (Unit 1, ADR-0007).
//
// The invariant this pipe now promises: it COMPUTES the verdict from read-only NAV
// (auto-release recency, a genuinely stuck in-process CU 50007, real Status=0
// staging backlog) and keeps the middleware level ONLY as a cross-check. The two
// boundaries every case pins: a healthy system reads GREEN (the false "Stuck" the
// live run showed must not fire) AND a true fault still ambers/reds.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adoptMiddlewareVerdict,
  computeJobQueue,
  type JobQueueInput,
  type JobQueueThresholds,
} from './jobQueue.js';

const NOW = Date.parse('2026-07-13T18:00:00.000Z');

// Mirrors config.jobQueue defaults: auto-release amber 30m / red 60m; in-process
// amber 60m / red 90m; pending-staging amber 25 / red 100.
const T: JobQueueThresholds = {
  autoReleaseAmberSeconds: 1800,
  autoReleaseRedSeconds: 3600,
  inProcessAmberSeconds: 3600,
  inProcessRedSeconds: 5400,
  pendingStagingAmberCount: 25,
  pendingStagingRedCount: 100,
  stuckJobWarnSeconds: 1800,
};

function ago(secondsAgo: number): string {
  return new Date(NOW - secondsAgo * 1000).toISOString();
}

// A healthy moment: auto-release fired minutes ago, no in-process job, 0 pending
// staging. The middleware still claims "Stuck" (the live-run false signal).
function healthy(overrides: Partial<JobQueueInput> = {}): JobQueueInput {
  return {
    autoReleaseFiredAt: ago(270), // 4.5 min ago (the live-run healthy moment)
    oldestInProcessJobAt: null,
    inProcessJobCount: 0,
    pendingStagingCount: 0,
    middlewareVerdict: 'Stuck',
    middlewareStuckStagingCount: 1988,
    stuckJobCount: 1,
    checkedAt: ago(20),
    ...overrides,
  };
}

// --- Healthy reads GREEN (the core fidelity fix) ---------------------------
test('healthy NAV reads GREEN even while the middleware claims "Stuck"', () => {
  const r = computeJobQueue(healthy(), T, NOW);
  assert.equal(r.pipeVerdict, 'green');
  assert.equal(r.livenessVerdict, 'green');
  assert.equal(r.stuckJobVerdict, 'green');
  assert.equal(r.stagingVerdict, 'green');
  // The middleware claim is surfaced as a cross-check, never adopted as the verdict.
  assert.equal(r.detail.middleware_verdict_raw, 'Stuck');
  assert.equal(r.detail.source, 'nav:job-queue-log+staging');
});

test('a normal long IABC run (53 min in process) stays GREEN, not stuck', () => {
  // The exact false positive from the live run: a legitimate 20 to 47 min IABC job
  // running 53 min. Under the ~60 min threshold it must not read stuck.
  const r = computeJobQueue(
    healthy({ inProcessJobCount: 1, oldestInProcessJobAt: ago(53 * 60) }),
    T,
    NOW,
  );
  assert.equal(r.stuckJobVerdict, 'green');
  assert.equal(r.pipeVerdict, 'green');
});

// --- True faults still fire -------------------------------------------------
test('a genuinely stuck in-process job (95 min) reds the pipe', () => {
  const r = computeJobQueue(
    healthy({ inProcessJobCount: 1, oldestInProcessJobAt: ago(95 * 60) }),
    T,
    NOW,
  );
  assert.equal(r.stuckJobVerdict, 'red');
  assert.equal(r.pipeVerdict, 'red');
});

test('the in-process stuck-job band boundaries (60 min amber, 90 min red)', () => {
  const at = (s: number) =>
    computeJobQueue(healthy({ inProcessJobCount: 1, oldestInProcessJobAt: ago(s) }), T, NOW)
      .stuckJobVerdict;
  assert.equal(at(3600 - 1), 'green'); // just under 60 min
  assert.equal(at(3600), 'amber'); // 60 min
  assert.equal(at(5400 - 1), 'amber'); // just under 90 min
  assert.equal(at(5400), 'red'); // 90 min
});

test('a stale auto-release (liveness) ambers then reds', () => {
  const at = (s: number) => computeJobQueue(healthy({ autoReleaseFiredAt: ago(s) }), T, NOW).livenessVerdict;
  assert.equal(at(1800 - 1), 'green');
  assert.equal(at(1800), 'amber'); // 30 min
  assert.equal(at(3600), 'red'); // 60 min
});

test('a real Status=0 staging backlog ambers then reds', () => {
  const at = (n: number) => computeJobQueue(healthy({ pendingStagingCount: n }), T, NOW).stagingVerdict;
  assert.equal(at(24), 'green');
  assert.equal(at(25), 'amber');
  assert.equal(at(99), 'amber');
  assert.equal(at(100), 'red');
});

// --- Unread source is unknown, never a false green -------------------------
test('an unread NAV source is unknown, not a false green', () => {
  const r = computeJobQueue(
    healthy({
      autoReleaseFiredAt: null,
      oldestInProcessJobAt: null,
      inProcessJobCount: null,
      pendingStagingCount: null,
    }),
    T,
    NOW,
  );
  assert.equal(r.livenessVerdict, 'unknown');
  assert.equal(r.stuckJobVerdict, 'unknown');
  assert.equal(r.stagingVerdict, 'unknown');
  assert.equal(r.pipeVerdict, 'unknown');
});

test('no in-process job (count 0) is GREEN even with a null timestamp (nothing can be stuck)', () => {
  const r = computeJobQueue(
    healthy({ inProcessJobCount: 0, oldestInProcessJobAt: null }),
    T,
    NOW,
  );
  assert.equal(r.stuckJobVerdict, 'green');
});

// --- The verdict does NOT track the middleware level -----------------------
test('the middleware level does not move the verdict (NAV healthy stays green)', () => {
  for (const level of ['Stuck', 'red', 'critical', 'unknown', null]) {
    const r = computeJobQueue(healthy({ middlewareVerdict: level }), T, NOW);
    assert.equal(r.pipeVerdict, 'green', `middleware level ${String(level)} must not gate the verdict`);
  }
});

// --- adoptMiddlewareVerdict is a cross-check label only --------------------
test('adoptMiddlewareVerdict maps the level for the cross-check display', () => {
  assert.equal(adoptMiddlewareVerdict('ok'), 'green');
  assert.equal(adoptMiddlewareVerdict('Stuck'), 'red');
  assert.equal(adoptMiddlewareVerdict('degraded'), 'amber');
  assert.equal(adoptMiddlewareVerdict(null), 'unknown');
  assert.equal(adoptMiddlewareVerdict('nonsense'), 'unknown');
});

// --- Detail carries the sub-verdicts + the cross-check numbers -------------
test('detail carries the NAV sub-verdicts and the middleware cross-check', () => {
  const r = computeJobQueue(
    healthy({ inProcessJobCount: 2, oldestInProcessJobAt: ago(600), pendingStagingCount: 3 }),
    T,
    NOW,
  );
  assert.equal(r.detail.liveness_verdict, 'green');
  assert.equal(r.detail.stuck_job_verdict, 'green');
  assert.equal(r.detail.staging_verdict, 'green');
  assert.equal(r.detail.in_process_job_count, 2);
  assert.equal(r.detail.pending_staging_count, 3);
  assert.equal(r.detail.auto_release_age_s, 270);
  assert.equal(r.detail.middleware_verdict_raw, 'Stuck');
  assert.equal(r.detail.middleware_stuck_staging_count, 1988);
  assert.equal(r.detail.stuck_job_count, 1);
});
