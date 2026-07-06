// Verdict-correctness tests for the Price Sync Monitor (design.md 3). Freshness
// (last received) and liveness (last run) are cycle-banded and INDEPENDENT, so a
// dead syncer reds the pipe even when the last received data still looks fresh.
// Every case is a SEEDED input through the pure computePriceSync.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computePriceSync,
  type PriceSyncInput,
  type PriceSyncThresholds,
} from './priceSync.js';

const NOW = Date.parse('2026-07-05T18:00:00.000Z');

// cycle 1h, green<1c, amber 1-2c, red>=2c.
const T: PriceSyncThresholds = {
  cycleSeconds: 3600,
  freshnessAmberCycles: 1,
  freshnessRedCycles: 2,
  livenessAmberCycles: 1,
  livenessRedCycles: 2,
};

function ago(secondsAgo: number): string {
  return new Date(NOW - secondsAgo * 1000).toISOString();
}

function baseInput(overrides: Partial<PriceSyncInput> = {}): PriceSyncInput {
  return {
    lastReceivedAt: ago(600), // 10 min ago => fresh
    lastRunAt: ago(30),       // 30s ago => alive
    ...overrides,
  };
}

// --- Freshness (last received) boundary ------------------------------------
test('freshness: received under one cycle is green', () => {
  const r = computePriceSync(baseInput({ lastReceivedAt: ago(3600 - 1) }), T, NOW);
  assert.equal(r.freshnessVerdict, 'green');
});

test('freshness: one-cycle-stale received is amber', () => {
  const r = computePriceSync(baseInput({ lastReceivedAt: ago(3600) }), T, NOW);
  assert.equal(r.freshnessVerdict, 'amber');
});

test('freshness: two-cycle-stale received is red', () => {
  const r = computePriceSync(baseInput({ lastReceivedAt: ago(2 * 3600) }), T, NOW);
  assert.equal(r.freshnessVerdict, 'red');
  assert.equal(r.lastReceivedAgeS, 2 * 3600);
});

test('freshness: no received timestamp is unknown', () => {
  const r = computePriceSync(baseInput({ lastReceivedAt: null }), T, NOW);
  assert.equal(r.freshnessVerdict, 'unknown');
  assert.equal(r.lastReceivedAgeS, null);
});

// --- Liveness (last run) boundary, independent of freshness ----------------
test('liveness: recent run is green', () => {
  const r = computePriceSync(baseInput({ lastRunAt: ago(60) }), T, NOW);
  assert.equal(r.livenessVerdict, 'green');
});

test('liveness: dead syncer (beyond two cycles) is red', () => {
  const r = computePriceSync(baseInput({ lastRunAt: ago(3 * 3600) }), T, NOW);
  assert.equal(r.livenessVerdict, 'red');
});

test('liveness is independent of freshness: fresh data but dead syncer still reds the pipe', () => {
  const r = computePriceSync(
    baseInput({ lastReceivedAt: ago(300), lastRunAt: ago(4 * 3600) }),
    T,
    NOW,
  );
  assert.equal(r.freshnessVerdict, 'green');
  assert.equal(r.livenessVerdict, 'red');
  assert.equal(r.pipeVerdict, 'red');
});

// --- Rollup + detail -------------------------------------------------------
test('rollup: all-healthy inputs produce a green pipe', () => {
  const r = computePriceSync(baseInput(), T, NOW);
  assert.equal(r.pipeVerdict, 'green');
});

test('rollup: worst wins (amber freshness, green liveness => amber pipe)', () => {
  const r = computePriceSync(baseInput({ lastReceivedAt: ago(3600) }), T, NOW);
  assert.equal(r.pipeVerdict, 'amber');
});

test('rollup: empty inputs produce unknown, not a false green', () => {
  const r = computePriceSync({ lastReceivedAt: null, lastRunAt: null }, T, NOW);
  assert.equal(r.freshnessVerdict, 'unknown');
  assert.equal(r.livenessVerdict, 'unknown');
  assert.equal(r.pipeVerdict, 'unknown');
});

test('detail carries received/run timestamps and ages', () => {
  const r = computePriceSync(baseInput({ lastReceivedAt: ago(600), lastRunAt: ago(30) }), T, NOW);
  assert.equal(r.detail.last_received_age_s, 600);
  assert.equal(r.detail.last_run_age_s, 30);
  assert.equal(r.detail.last_received_at, ago(600));
  assert.equal(r.detail.last_run_at, ago(30));
});
