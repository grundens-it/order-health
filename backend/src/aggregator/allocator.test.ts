// Verdict-correctness tests for the Allocator (Warehouse Split) monitor (Unit 4,
// design.md 5A.5, QA seat). No live middleware / NAV: every case is a SEEDED
// input through the pure computeAllocator. Run with `npm test` (node:test).
//
// Mirrors inventorySync.test.ts: assert each verdict at its boundary, plus the
// split-sanity signal (rate of un-allocatable / failed splits) and the rollup.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AllocationDecision } from '@order-health/shared';
import {
  computeAllocator,
  type AllocatorInput,
  type AllocatorThresholds,
} from './allocator.js';

// Fixed clock so every age is deterministic.
const NOW = Date.parse('2026-07-05T18:00:00.000Z');

// Defaults mirror config.allocator: cycle 5m, freshness/liveness green<3c,
// amber 3-6c, red>=6c; split-sanity amber at 5%, red at 15%.
const T: AllocatorThresholds = {
  cycleSeconds: 300,
  freshnessAmberCycles: 3,
  freshnessRedCycles: 6,
  livenessAmberCycles: 3,
  livenessRedCycles: 6,
  failedAmberRatio: 0.05,
  failedRedRatio: 0.15,
};

// An ISO timestamp `secondsAgo` before NOW.
function ago(secondsAgo: number): string {
  return new Date(NOW - secondsAgo * 1000).toISOString();
}

function decision(overrides: Partial<AllocationDecision> = {}): AllocationDecision {
  return {
    decided_at: ago(120),
    order_ref: 'SP-319114',
    channel: 'dtc',
    sku: 'Neptune Jacket / L',
    qty: 1,
    rule: 'single-unit -> OLD',
    location: 'TAC',
    outcome: 'allocated',
    ...overrides,
  };
}

// A healthy baseline input we perturb per test: fresh decisions, live heartbeat,
// clean window (0 unallocatable / 0 failed out of 1,204 decisions).
function baseInput(overrides: Partial<AllocatorInput> = {}): AllocatorInput {
  return {
    lastDecisionAt: ago(120), // 2 min ago => fresh
    serviceHeartbeatAt: ago(20), // 20s ago => alive
    windowSeconds: 86400,
    decisionsWindow: 1204,
    splitCount: 373, // ~31% split rate (demo)
    unallocatableCount: 0, // in-window failures
    failedCount: 0,
    atpFallbackCount: 2,
    oosHeldCount: 0,
    oosHeldOldestAgeS: null,
    decisions: [decision(), decision({ order_ref: 'SP-319108', outcome: 'split' })],
    ...overrides,
  };
}

// --- Decision freshness boundary ------------------------------------------
test('freshness: recent decision (under three cycles) is green', () => {
  const r = computeAllocator(baseInput({ lastDecisionAt: ago(3 * 300 - 1) }), T, NOW);
  assert.equal(r.freshnessVerdict, 'green');
});

test('freshness: three-cycle-stale decision is amber', () => {
  const r = computeAllocator(baseInput({ lastDecisionAt: ago(3 * 300) }), T, NOW);
  assert.equal(r.freshnessVerdict, 'amber');
});

test('freshness: six-cycle-stale decision is red', () => {
  const r = computeAllocator(baseInput({ lastDecisionAt: ago(6 * 300) }), T, NOW);
  assert.equal(r.freshnessVerdict, 'red');
  assert.equal(r.decisionLagS, 6 * 300);
});

test('freshness: no decision timestamp is unknown', () => {
  const r = computeAllocator(baseInput({ lastDecisionAt: null }), T, NOW);
  assert.equal(r.freshnessVerdict, 'unknown');
  assert.equal(r.decisionLagS, null);
});

// --- Allocator liveness boundary (independent of freshness) ----------------
test('liveness: recent heartbeat is green', () => {
  const r = computeAllocator(baseInput({ serviceHeartbeatAt: ago(30) }), T, NOW);
  assert.equal(r.livenessVerdict, 'green');
});

test('liveness: dead allocator (beyond six cycles) is red', () => {
  const r = computeAllocator(baseInput({ serviceHeartbeatAt: ago(7 * 300) }), T, NOW);
  assert.equal(r.livenessVerdict, 'red');
});

test('liveness is independent of freshness: fresh decisions but dead loop still reds the pipe', () => {
  const r = computeAllocator(
    baseInput({ lastDecisionAt: ago(60), serviceHeartbeatAt: ago(8 * 300) }),
    T,
    NOW,
  );
  assert.equal(r.freshnessVerdict, 'green');
  assert.equal(r.livenessVerdict, 'red');
  assert.equal(r.pipeVerdict, 'red');
});

// --- Split-sanity signal (rate of un-allocatable / failed splits) ----------
test('sanity: clean window (no failures) is green', () => {
  const r = computeAllocator(baseInput(), T, NOW);
  assert.equal(r.sanityVerdict, 'green');
  assert.equal(r.detail.sanity.failed_rate, 0);
});

test('sanity: failure share at the amber ratio is amber', () => {
  // 60 unallocatable of 1,200 = exactly 5%.
  const r = computeAllocator(
    baseInput({ decisionsWindow: 1200, unallocatableCount: 60, failedCount: 0 }),
    T,
    NOW,
  );
  assert.equal(r.sanityVerdict, 'amber');
  assert.equal(r.detail.sanity.failed_rate, 0.05);
});

test('sanity: failure share at the red ratio goes RED (not amber-capped)', () => {
  // 120 unallocatable + 60 failed of 1,200 = 15%. A broken allocator reds.
  const r = computeAllocator(
    baseInput({ decisionsWindow: 1200, unallocatableCount: 120, failedCount: 60 }),
    T,
    NOW,
  );
  assert.equal(r.sanityVerdict, 'red');
  assert.equal(r.pipeVerdict, 'red');
});

// --- The core fidelity fix: the OOS-held backlog is NOT in the rate ---------
test('sanity: a standing OOS-held backlog does NOT amber the pipe (the live-run fix)', () => {
  // The exact live scenario: 22 OOS-held orders (median 6.8 days) with a CLEAN
  // 200-decision window. Old code did 22/200 = 0.11 => amber forever. Now the
  // backlog rides in oosHeld* and the rate is 0 => green.
  const r = computeAllocator(
    baseInput({
      decisionsWindow: 200,
      unallocatableCount: 0, // no failures inside the sampled window
      failedCount: 0,
      oosHeldCount: 22,
      oosHeldOldestAgeS: Math.round(10.9 * 86400),
    }),
    T,
    NOW,
  );
  assert.equal(r.detail.sanity.failed_rate, 0);
  assert.equal(r.sanityVerdict, 'green');
  assert.equal(r.pipeVerdict, 'green');
  // The backlog is surfaced separately as its own labelled count/age.
  assert.equal(r.detail.sanity.oos_held_count, 22);
  assert.equal(r.detail.sanity.oos_held_oldest_age_s, Math.round(10.9 * 86400));
});

test('sanity: a genuine in-window failure share still fires even with no backlog', () => {
  // The true-fault boundary: 24 unallocatable decisions INSIDE a 200-decision
  // window = 12% => amber (and no OOS-held backlog at all).
  const r = computeAllocator(
    baseInput({ decisionsWindow: 200, unallocatableCount: 24, failedCount: 0, oosHeldCount: 0 }),
    T,
    NOW,
  );
  assert.equal(r.detail.sanity.failed_rate, 0.12);
  assert.equal(r.sanityVerdict, 'amber');
});

test('sanity: no window is unknown, not a false green', () => {
  const r = computeAllocator(baseInput({ decisionsWindow: null }), T, NOW);
  assert.equal(r.sanityVerdict, 'unknown');
  assert.equal(r.detail.sanity.failed_rate, null);
});

test('sanity: split_rate is surfaced in detail', () => {
  const r = computeAllocator(
    baseInput({ decisionsWindow: 1000, splitCount: 310 }),
    T,
    NOW,
  );
  assert.equal(r.detail.sanity.split_rate, 0.31);
  assert.equal(r.detail.sanity.atp_fallback_count, 2);
});

// --- Detail bag + rollup ---------------------------------------------------
test('detail carries the recent decisions and window metadata', () => {
  const r = computeAllocator(baseInput(), T, NOW);
  assert.equal(r.detail.recent_decisions.length, 2);
  assert.equal(r.detail.recent_decisions[0]?.order_ref, 'SP-319114');
  assert.equal(r.detail.window_seconds, 86400);
  assert.equal(r.detail.last_decision_at, r.lastDecisionAt);
});

test('rollup: all-healthy inputs produce a green pipe', () => {
  const r = computeAllocator(baseInput(), T, NOW);
  assert.equal(r.pipeVerdict, 'green');
});

test('rollup: worst of the three wins (amber sanity with green freshness/liveness => amber)', () => {
  const r = computeAllocator(
    baseInput({ decisionsWindow: 1000, unallocatableCount: 80 }), // 8% => amber
    T,
    NOW,
  );
  assert.equal(r.freshnessVerdict, 'green');
  assert.equal(r.livenessVerdict, 'green');
  assert.equal(r.sanityVerdict, 'amber');
  assert.equal(r.pipeVerdict, 'amber');
});

test('rollup: empty inputs produce unknown, not a false green or red', () => {
  const r = computeAllocator(
    {
      lastDecisionAt: null,
      serviceHeartbeatAt: null,
      windowSeconds: null,
      decisionsWindow: null,
      splitCount: null,
      unallocatableCount: null,
      failedCount: null,
      atpFallbackCount: null,
      oosHeldCount: null,
      oosHeldOldestAgeS: null,
      decisions: [],
    },
    T,
    NOW,
  );
  assert.equal(r.freshnessVerdict, 'unknown');
  assert.equal(r.livenessVerdict, 'unknown');
  assert.equal(r.sanityVerdict, 'unknown');
  assert.equal(r.pipeVerdict, 'unknown');
});
