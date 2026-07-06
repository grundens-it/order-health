// Verdict-correctness tests for the Back-sync Monitor (Unit 2). No live NAV /
// middleware: every case is a SEEDED input through the pure computeBackSync. Run
// with `npm test` (node:test, built into Node >= 20).
//
// Mirrors inventorySync.test.ts: assert each verdict at its boundary. The key
// contrast with Unit 1 is that the missed-shipments signal is NOT amber-capped: a
// cluster of missed shipments CAN red the pipe (design.md 5 "Missed back-sync").
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MissedShipment } from '@order-health/shared';
import {
  computeBackSync,
  missedCountVerdict,
  type BackSyncInput,
  type BackSyncThresholds,
} from './backSync.js';

// Fixed clock so every age is deterministic.
const NOW = Date.parse('2026-07-05T18:00:00.000Z');

// Defaults mirror config.backSync: cycle 1h, green<1c, amber 1-2c, red>=2c;
// missed amber at 1, red at 5, over a 14-day window.
const T: BackSyncThresholds = {
  cycleSeconds: 3600,
  freshnessAmberCycles: 1,
  freshnessRedCycles: 2,
  livenessAmberCycles: 1,
  livenessRedCycles: 2,
  missedWindowDays: 14,
  missedAmberCount: 1,
  missedRedCount: 5,
};

// An ISO timestamp `secondsAgo` before NOW.
function ago(secondsAgo: number): string {
  return new Date(NOW - secondsAgo * 1000).toISOString();
}

function missed(n: number): MissedShipment[] {
  return Array.from({ length: n }, (_, i) => ({
    order_ref: `SP-${319090 + i}`,
    web_id: `7734921${String(i).padStart(3, '0')}`,
    nav_shipment_no: `GRUS-SH-${118844 + i}`,
    carrier: 'UPS',
    tracking: `1Z999AA101234567${String(i).padStart(2, '0')}`,
    posted_at: ago(6 * 3600),
    age_s: 6 * 3600,
    reason: 'fulfillmentCreate not yet sent',
  }));
}

// A healthy baseline input we perturb per test: fresh watermark, live watcher,
// zero missed shipments.
function baseInput(overrides: Partial<BackSyncInput> = {}): BackSyncInput {
  return {
    lastBackSyncAt: ago(22 * 60), // 22 min ago => fresh (demo value)
    watcherHeartbeatAt: ago(30), // 30s ago => alive
    fulfillmentsLast24h: 231,
    errorsLast24h: 0,
    missedShipments: [],
    ...overrides,
  };
}

// --- Back-sync watermark freshness boundary --------------------------------
test('freshness: recent fulfillmentCreate (under one cycle) is green', () => {
  const r = computeBackSync(baseInput({ lastBackSyncAt: ago(3600 - 1) }), T, NOW);
  assert.equal(r.freshnessVerdict, 'green');
});

test('freshness: one-cycle-stale watermark is amber', () => {
  const r = computeBackSync(baseInput({ lastBackSyncAt: ago(3600) }), T, NOW);
  assert.equal(r.freshnessVerdict, 'amber');
});

test('freshness: multi-cycle-stale watermark is red', () => {
  const r = computeBackSync(baseInput({ lastBackSyncAt: ago(2 * 3600) }), T, NOW);
  assert.equal(r.freshnessVerdict, 'red');
  assert.equal(r.watermarkLagS, 2 * 3600);
});

test('freshness: no back-sync timestamp is unknown', () => {
  const r = computeBackSync(baseInput({ lastBackSyncAt: null }), T, NOW);
  assert.equal(r.freshnessVerdict, 'unknown');
  assert.equal(r.watermarkLagS, null);
});

// --- Watcher liveness boundary (independent of freshness) ------------------
test('liveness: recent heartbeat is green', () => {
  const r = computeBackSync(baseInput({ watcherHeartbeatAt: ago(60) }), T, NOW);
  assert.equal(r.livenessVerdict, 'green');
});

test('liveness: dead watcher (beyond two cycles) is red', () => {
  const r = computeBackSync(baseInput({ watcherHeartbeatAt: ago(3 * 3600) }), T, NOW);
  assert.equal(r.livenessVerdict, 'red');
});

test('liveness is independent of freshness: fresh back-sync but dead watcher still reds the pipe', () => {
  const r = computeBackSync(
    baseInput({ lastBackSyncAt: ago(300), watcherHeartbeatAt: ago(4 * 3600) }),
    T,
    NOW,
  );
  assert.equal(r.freshnessVerdict, 'green');
  assert.equal(r.livenessVerdict, 'red');
  assert.equal(r.pipeVerdict, 'red');
});

// --- Missed-shipments signal boundary (uncapped, may be RED) ---------------
test('missed: zero missed shipments is green', () => {
  const r = computeBackSync(baseInput({ missedShipments: [] }), T, NOW);
  assert.equal(r.missedVerdict, 'green');
  assert.equal(r.detail.missed_count, 0);
});

test('missed: one missed shipment is amber (the demo "Missed 14d: 1")', () => {
  const r = computeBackSync(baseInput({ missedShipments: missed(1) }), T, NOW);
  assert.equal(r.missedVerdict, 'amber');
  assert.equal(r.detail.missed_count, 1);
  assert.equal(r.detail.missed_shipments[0].order_ref, 'SP-319090');
});

test('missed: a cluster (>= red count) reds the missed signal AND the pipe (NOT capped)', () => {
  const r = computeBackSync(baseInput({ missedShipments: missed(5) }), T, NOW);
  assert.equal(r.missedVerdict, 'red');
  // The deliberate contrast with inventory-sync's amber-capped divergence: a real
  // backlog escalates the pipe to RED even with green freshness and liveness.
  assert.equal(r.freshnessVerdict, 'green');
  assert.equal(r.livenessVerdict, 'green');
  assert.equal(r.pipeVerdict, 'red');
});

test('missed: null (endpoint not queried) is unknown, not a false green', () => {
  const r = computeBackSync(baseInput({ missedShipments: null }), T, NOW);
  assert.equal(r.missedVerdict, 'unknown');
  assert.equal(r.detail.missed_count, 0);
});

test('missedCountVerdict bands: null=>unknown, 0=>green, amber boundary, red boundary', () => {
  assert.equal(missedCountVerdict(null, 1, 5), 'unknown');
  assert.equal(missedCountVerdict(0, 1, 5), 'green');
  assert.equal(missedCountVerdict(1, 1, 5), 'amber');
  assert.equal(missedCountVerdict(4, 1, 5), 'amber');
  assert.equal(missedCountVerdict(5, 1, 5), 'red');
});

// --- Detail bag + rollup ---------------------------------------------------
test('detail carries the missed count, window, counters and rows', () => {
  const r = computeBackSync(
    baseInput({ missedShipments: missed(2), fulfillmentsLast24h: 231, errorsLast24h: 0 }),
    T,
    NOW,
  );
  assert.equal(r.detail.missed_count, 2);
  assert.equal(r.detail.missed_window_days, 14);
  assert.equal(r.detail.fulfillments_last_24h, 231);
  assert.equal(r.detail.errors_last_24h, 0);
  assert.equal(r.detail.missed_shipments.length, 2);
  assert.equal(r.detail.last_back_sync_at, r.lastProgressAt);
});

test('rollup: all-healthy inputs produce a green pipe', () => {
  const r = computeBackSync(baseInput(), T, NOW);
  assert.equal(r.pipeVerdict, 'green');
});

test('rollup: empty/null inputs produce unknown, not a false green or red', () => {
  const r = computeBackSync(
    {
      lastBackSyncAt: null,
      watcherHeartbeatAt: null,
      fulfillmentsLast24h: null,
      errorsLast24h: null,
      missedShipments: null,
    },
    T,
    NOW,
  );
  assert.equal(r.freshnessVerdict, 'unknown');
  assert.equal(r.livenessVerdict, 'unknown');
  assert.equal(r.missedVerdict, 'unknown');
  assert.equal(r.pipeVerdict, 'unknown');
});
