// Verdict-correctness tests for the NAV Job Queue Monitor (design.md 6).
//
// The invariant this pipe promises: it CONSUMES the middleware's already-computed
// verdict and surfaces it UNCHANGED (green -> green, red -> red). It never
// re-derives job-queue health from the supporting numbers. Every case is a
// SEEDED input through the pure computeJobQueue.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adoptMiddlewareVerdict,
  computeJobQueue,
  type JobQueueInput,
  type JobQueueThresholds,
} from './jobQueue.js';

const NOW = Date.parse('2026-07-05T18:00:00.000Z');

const T: JobQueueThresholds = { stuckJobWarnSeconds: 1800 };

function ago(secondsAgo: number): string {
  return new Date(NOW - secondsAgo * 1000).toISOString();
}

function baseInput(overrides: Partial<JobQueueInput> = {}): JobQueueInput {
  return {
    middlewareVerdict: 'green',
    autoReleaseFiredAt: ago(120),
    longestRunningJobS: 45,
    stuckJobCount: 0,
    checkedAt: ago(20),
    ...overrides,
  };
}

// --- Passthrough invariant: adopt, never recompute --------------------------
test('adopts a GREEN middleware verdict unchanged (green -> green)', () => {
  const r = computeJobQueue(baseInput({ middlewareVerdict: 'green' }), T, NOW);
  assert.equal(r.pipeVerdict, 'green');
  assert.equal(r.adoptedVerdict, 'green');
});

test('adopts a RED middleware verdict unchanged (red -> red)', () => {
  // Even with a stuck-job count, the verdict is whatever the middleware said: we
  // do NOT re-derive it from stuck_job_count / longest_running_job_s.
  const r = computeJobQueue(
    baseInput({ middlewareVerdict: 'red', stuckJobCount: 3, longestRunningJobS: 5400 }),
    T,
    NOW,
  );
  assert.equal(r.pipeVerdict, 'red');
});

test('adopts an AMBER middleware verdict unchanged (amber -> amber)', () => {
  const r = computeJobQueue(baseInput({ middlewareVerdict: 'amber' }), T, NOW);
  assert.equal(r.pipeVerdict, 'amber');
});

test('does NOT recompute: healthy-looking numbers under a RED verdict stay RED', () => {
  // No stuck jobs, recent auto-release: naive re-derivation would say green. We
  // must surface the middleware's RED regardless (consume, not recompute).
  const r = computeJobQueue(
    baseInput({ middlewareVerdict: 'red', stuckJobCount: 0, longestRunningJobS: 10 }),
    T,
    NOW,
  );
  assert.equal(r.pipeVerdict, 'red');
});

test('a missing / null verdict is unknown, not a false green', () => {
  const r = computeJobQueue(baseInput({ middlewareVerdict: null }), T, NOW);
  assert.equal(r.pipeVerdict, 'unknown');
  assert.equal(r.adoptedVerdict, 'unknown');
});

test('an unrecognised verdict string is unknown, not a guess', () => {
  const r = computeJobQueue(baseInput({ middlewareVerdict: 'purple' }), T, NOW);
  assert.equal(r.pipeVerdict, 'unknown');
});

// --- adoptMiddlewareVerdict label map --------------------------------------
test('adoptMiddlewareVerdict maps synonyms without changing meaning', () => {
  assert.equal(adoptMiddlewareVerdict('GREEN'), 'green');
  assert.equal(adoptMiddlewareVerdict('healthy'), 'green');
  assert.equal(adoptMiddlewareVerdict('degraded'), 'amber');
  assert.equal(adoptMiddlewareVerdict('critical'), 'red');
  assert.equal(adoptMiddlewareVerdict(null), 'unknown');
  assert.equal(adoptMiddlewareVerdict('nonsense'), 'unknown');
});

// --- Supporting numbers ride in detail (context only) ----------------------
test('detail carries the middleware supporting numbers and marks the source', () => {
  const r = computeJobQueue(
    baseInput({ middlewareVerdict: 'amber', stuckJobCount: 1, longestRunningJobS: 2000 }),
    T,
    NOW,
  );
  assert.equal(r.detail.source, 'middleware:job-queue/health');
  assert.equal(r.detail.adopted_verdict, 'amber');
  assert.equal(r.detail.middleware_verdict_raw, 'amber');
  assert.equal(r.detail.stuck_job_count, 1);
  assert.equal(r.detail.longest_running_job_s, 2000);
  assert.equal(r.detail.auto_release_age_s, 120);
  assert.equal(r.detail.checked_at, ago(20));
});
