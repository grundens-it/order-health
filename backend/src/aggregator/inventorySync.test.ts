// Verdict-correctness tests for the Inventory Sync Monitor (design.md 5A.5, QA
// seat). No live NAV / middleware: every case is a SEEDED input through the pure
// computeInventorySync. Run with `npm test` (node:test, built into Node >= 20).
//
// This is the test structure Units 2 to 6 copy: assert each verdict at its
// boundary, and assert the amber-cap invariant.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { InventoryWalk } from '@order-health/shared';
import {
  capAmberNeverRed,
  computeInventorySync,
  type InventorySyncInput,
  type InventorySyncThresholds,
} from './inventorySync.js';

// Fixed clock so every age is deterministic.
const NOW = Date.parse('2026-07-05T18:00:00.000Z');

// Defaults mirror config.inventorySync: cycle 2h. Freshness green<1c, amber 1-2c,
// red>=2c. Liveness is WIDER (Unit 3, health-fidelity): amber at 2 missed walk
// cadences, red at 3, because walks legitimately run about every 2h so a heartbeat
// is up to one full inter-walk gap old right before the next run. Divergence amber
// above 5x.
const T: InventorySyncThresholds = {
  cycleSeconds: 7200,
  freshnessAmberCycles: 1,
  freshnessRedCycles: 2,
  livenessAmberCycles: 2,
  livenessRedCycles: 3,
  divergenceAmberRatio: 5,
};

// An ISO timestamp `secondsAgo` before NOW.
function ago(secondsAgo: number): string {
  return new Date(NOW - secondsAgo * 1000).toISOString();
}

function walk(pushed: number, untracked = 0): InventoryWalk {
  return { walk_at: ago(600), processed: 12218, pushed, skipped: 12218 - pushed, untracked_filtered: untracked };
}

// A healthy baseline input we perturb per test.
function baseInput(overrides: Partial<InventorySyncInput> = {}): InventorySyncInput {
  return {
    navNewestIabcEntryNo: 1321577,
    watermarkEntryNo: 1321577,
    lastWalkAt: ago(600), // 10 min ago => fresh
    watcherHeartbeatAt: ago(12), // 12s ago => alive
    walks: [walk(466), walk(118), walk(52)],
    dryRunWouldPush: null,
    dryRunAt: null,
    totalPairs: null,
    ...overrides,
  };
}

// --- Watermark freshness boundary -----------------------------------------
test('freshness: fresh watermark (under one cycle) is green', () => {
  const r = computeInventorySync(baseInput({ lastWalkAt: ago(7200 - 1) }), T, NOW);
  assert.equal(r.freshnessVerdict, 'green');
});

test('freshness: one-cycle-stale watermark is amber', () => {
  const r = computeInventorySync(baseInput({ lastWalkAt: ago(7200) }), T, NOW);
  assert.equal(r.freshnessVerdict, 'amber');
});

test('freshness: multi-cycle-stale watermark is red', () => {
  // ~6h stale (the outage case) is well past two cycles.
  const r = computeInventorySync(baseInput({ lastWalkAt: ago(2 * 7200) }), T, NOW);
  assert.equal(r.freshnessVerdict, 'red');
  assert.equal(r.watermarkLagS, 2 * 7200);
});

test('freshness: no walk timestamp is unknown', () => {
  const r = computeInventorySync(baseInput({ lastWalkAt: null }), T, NOW);
  assert.equal(r.freshnessVerdict, 'unknown');
  assert.equal(r.watermarkLagS, null);
});

// --- Watcher liveness boundary (Unit 3: widened to the ~2h walk cadence) ----
test('liveness: recent heartbeat is green', () => {
  const r = computeInventorySync(baseInput({ watcherHeartbeatAt: ago(30) }), T, NOW);
  assert.equal(r.livenessVerdict, 'green');
});

test('liveness: a 124-min heartbeat (just over one walk cadence) reads GREEN (the live-run fix)', () => {
  // The live-run false amber: heartbeat 124 min old, just over the OLD 120-min
  // (1-cycle) threshold, while walks legitimately run about every 2h. It must not
  // flip amber right before every run.
  const r = computeInventorySync(baseInput({ watcherHeartbeatAt: ago(124 * 60) }), T, NOW);
  assert.equal(r.livenessVerdict, 'green');
  assert.equal(r.pipeVerdict, 'green');
});

test('liveness: two missed cadences (>= 2 cycles) is amber', () => {
  const r = computeInventorySync(baseInput({ watcherHeartbeatAt: ago(2 * 7200) }), T, NOW);
  assert.equal(r.livenessVerdict, 'amber');
});

test('liveness: three missed cadences (>= 3 cycles) is red (a genuine stall still fires)', () => {
  const r = computeInventorySync(baseInput({ watcherHeartbeatAt: ago(3 * 7200) }), T, NOW);
  assert.equal(r.livenessVerdict, 'red');
});

test('liveness is independent of freshness: fresh data but a >3-cycle-dead watcher still reds the pipe', () => {
  // The part-1 failure mode: CU 50007 kept completing (data looks fresh) while
  // the middleware watcher died. Freshness green, liveness red => pipe red.
  const r = computeInventorySync(
    baseInput({ lastWalkAt: ago(300), watcherHeartbeatAt: ago(4 * 7200) }),
    T,
    NOW,
  );
  assert.equal(r.freshnessVerdict, 'green');
  assert.equal(r.livenessVerdict, 'red');
  assert.equal(r.pipeVerdict, 'red');
});

// --- Dry-run divergence: AMBER-capped, NEVER auto-red (design.md 5A.3) -----
test('divergence: large dry-run gap yields AMBER, never RED', () => {
  // The 7,245-of-12,218 case against a trailing live push of 466 => ratio ~15.5.
  const r = computeInventorySync(
    baseInput({ dryRunWouldPush: 7245, totalPairs: 12218, dryRunAt: ago(4500) }),
    T,
    NOW,
  );
  assert.equal(r.divergenceVerdict, 'amber');
  assert.notEqual(r.divergenceVerdict, 'red');
  assert.ok((r.detail.divergence.ratio ?? 0) > T.divergenceAmberRatio);
});

test('divergence: a huge gap with green freshness and liveness caps the pipe at AMBER, not RED', () => {
  // The core invariant: divergence alone cannot escalate the rollup past amber.
  const r = computeInventorySync(
    baseInput({ dryRunWouldPush: 999999, totalPairs: 12218 }),
    T,
    NOW,
  );
  assert.equal(r.freshnessVerdict, 'green');
  assert.equal(r.livenessVerdict, 'green');
  assert.equal(r.divergenceVerdict, 'amber');
  assert.equal(r.pipeVerdict, 'amber');
});

test('divergence: small gap under threshold is green', () => {
  const r = computeInventorySync(
    baseInput({ dryRunWouldPush: 500, totalPairs: 12218 }), // 500/466 ~= 1.07x
    T,
    NOW,
  );
  assert.equal(r.divergenceVerdict, 'green');
});

test('divergence: nonzero untracked_filtered is an amber onboarding signal', () => {
  const r = computeInventorySync(
    baseInput({ walks: [walk(200, 3), walk(118)] }),
    T,
    NOW,
  );
  assert.equal(r.divergenceVerdict, 'amber');
});

test('capAmberNeverRed maps red to amber and leaves others unchanged', () => {
  assert.equal(capAmberNeverRed('red'), 'amber');
  assert.equal(capAmberNeverRed('amber'), 'amber');
  assert.equal(capAmberNeverRed('green'), 'green');
  assert.equal(capAmberNeverRed('unknown'), 'unknown');
});

// --- Detail bag + rollup ---------------------------------------------------
test('detail carries divergence numbers, entry gap and recent walks', () => {
  const r = computeInventorySync(
    baseInput({ watermarkEntryNo: 1321421, navNewestIabcEntryNo: 1321577, dryRunWouldPush: 7245 }),
    T,
    NOW,
  );
  assert.equal(r.detail.watermark_entry_gap, 156);
  assert.equal(r.detail.trigger_mode, 'job_queue');
  assert.equal(r.detail.recent_walks.length, 3);
  assert.equal(r.detail.divergence.live_push_trailing, 466); // trailing MAX pushed
  assert.equal(r.detail.divergence.dryrun_would_push, 7245);
});

test('rollup: all-healthy inputs produce a green pipe', () => {
  const r = computeInventorySync(baseInput(), T, NOW);
  assert.equal(r.pipeVerdict, 'green');
});

test('rollup: empty inputs produce unknown, not a false green or red', () => {
  const r = computeInventorySync(
    {
      navNewestIabcEntryNo: null,
      watermarkEntryNo: null,
      lastWalkAt: null,
      watcherHeartbeatAt: null,
      walks: [],
      dryRunWouldPush: null,
      dryRunAt: null,
      totalPairs: null,
    },
    T,
    NOW,
  );
  assert.equal(r.freshnessVerdict, 'unknown');
  assert.equal(r.livenessVerdict, 'unknown');
  assert.equal(r.divergenceVerdict, 'unknown');
  assert.equal(r.pipeVerdict, 'unknown');
});
