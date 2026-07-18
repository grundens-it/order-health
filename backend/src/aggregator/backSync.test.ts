// Verdict-correctness tests for the Back-sync Monitor (Unit 2, health-fidelity).
// No live NAV / middleware: every case is a SEEDED input through the pure
// computeBackSync. Run with `npm test` (node:test, built into Node >= 20).
//
// The fidelity fix: the freshness/liveness clocks are GATED on unsynced work. A
// quiet shipping stretch (no DTC shipment newer than the last back-sync) is
// idle-not-behind and reads GREEN, never amber. The missed-shipments signal is
// unchanged and is NOT amber-capped: a cluster still reds the pipe.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MissedShipment } from '@order-health/shared';
import {
  computeBackSync,
  hasUnsyncedWork,
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

// A healthy, CAUGHT-UP baseline: last back-sync 22 min ago, watcher alive, zero
// missed, and the newest DTC shipment posted BEFORE the last back-sync (nothing
// unsynced). Tests perturb only what they exercise.
function baseInput(overrides: Partial<BackSyncInput> = {}): BackSyncInput {
  return {
    lastBackSyncAt: ago(22 * 60),
    watcherHeartbeatAt: ago(30),
    fulfillmentsLast24h: 231,
    errorsLast24h: 0,
    missedShipments: [],
    newestDtcShipmentAt: ago(40 * 60), // posted before the last back-sync => caught up
    ...overrides,
  };
}

// --- The core fidelity fix: a quiet stretch reads GREEN --------------------
test('a quiet, caught-up stretch reads GREEN even with an old watermark (the live-run fix)', () => {
  // The live-run false amber: newest back-sync 76 min old, but no new shipment to
  // sync (newest DTC shipment older than the watermark). Idle, not behind.
  const r = computeBackSync(
    baseInput({ lastBackSyncAt: ago(76 * 60), newestDtcShipmentAt: ago(80 * 60) }),
    T,
    NOW,
  );
  assert.equal(r.freshnessVerdict, 'green');
  assert.equal(r.livenessVerdict, 'green');
  assert.equal(r.pipeVerdict, 'green');
  assert.equal(r.detail.has_unsynced_work, false);
  assert.equal(r.detail.applicability, 'idle_no_traffic');
});

// --- Freshness ages ONLY against unsynced work -----------------------------
test('freshness: unsynced work waiting under one cycle is green', () => {
  // A DTC shipment posted 59 min ago, newer than the last back-sync => unsynced.
  const r = computeBackSync(
    baseInput({ lastBackSyncAt: ago(2 * 3600), newestDtcShipmentAt: ago(3600 - 1) }),
    T,
    NOW,
  );
  assert.equal(r.detail.has_unsynced_work, true);
  assert.equal(r.freshnessVerdict, 'green');
});

test('freshness: unsynced work waiting one cycle is amber', () => {
  const r = computeBackSync(
    baseInput({ lastBackSyncAt: ago(3 * 3600), newestDtcShipmentAt: ago(3600) }),
    T,
    NOW,
  );
  assert.equal(r.freshnessVerdict, 'amber');
  assert.equal(r.watermarkLagS, 3600);
});

test('freshness: unsynced work waiting multiple cycles is red (a genuine backlog)', () => {
  const r = computeBackSync(
    baseInput({ lastBackSyncAt: ago(4 * 3600), newestDtcShipmentAt: ago(2 * 3600) }),
    T,
    NOW,
  );
  assert.equal(r.freshnessVerdict, 'red');
  assert.equal(r.watermarkLagS, 2 * 3600);
  assert.equal(r.pipeVerdict, 'red');
});

// --- Liveness is gated the same way ----------------------------------------
test('liveness: a dead watcher with NO work to sync stays green (idle, not a fault)', () => {
  const r = computeBackSync(baseInput({ watcherHeartbeatAt: ago(4 * 3600) }), T, NOW);
  assert.equal(r.detail.has_unsynced_work, false);
  assert.equal(r.livenessVerdict, 'green');
});

test('liveness: a dead watcher WHILE work is waiting reds the pipe', () => {
  const r = computeBackSync(
    baseInput({
      lastBackSyncAt: ago(3 * 3600),
      newestDtcShipmentAt: ago(300), // fresh unsynced work
      watcherHeartbeatAt: ago(4 * 3600),
    }),
    T,
    NOW,
  );
  assert.equal(r.detail.has_unsynced_work, true);
  assert.equal(r.freshnessVerdict, 'green'); // work only 5 min old
  assert.equal(r.livenessVerdict, 'red');
  assert.equal(r.pipeVerdict, 'red');
});

// --- The has-work gate itself ----------------------------------------------
test('hasUnsyncedWork: newer shipment => true, older => false, null shipment => false', () => {
  assert.equal(hasUnsyncedWork(ago(60), ago(600)), true); // shipment newer than watermark
  assert.equal(hasUnsyncedWork(ago(600), ago(60)), false); // shipment older than watermark
  assert.equal(hasUnsyncedWork(null, ago(60)), false); // no DTC shipment => nothing to sync
  assert.equal(hasUnsyncedWork(ago(60), null), true); // shipment exists, never synced
});

// --- Missed-shipments signal is UNCHANGED (uncapped, may be RED) -----------
test('missed: a cluster reds the pipe even while freshness/liveness are idle-green', () => {
  const r = computeBackSync(baseInput({ missedShipments: missed(5) }), T, NOW);
  assert.equal(r.missedVerdict, 'red');
  assert.equal(r.freshnessVerdict, 'green');
  assert.equal(r.livenessVerdict, 'green');
  assert.equal(r.pipeVerdict, 'red');
  // A real backlog is not idle: applicability stays active, not idle_no_traffic.
  assert.equal(r.detail.applicability, 'active');
});

test('missed: one missed shipment is amber (the demo "Missed 14d: 1")', () => {
  const r = computeBackSync(baseInput({ missedShipments: missed(1) }), T, NOW);
  assert.equal(r.missedVerdict, 'amber');
  assert.equal(r.detail.missed_count, 1);
  assert.equal(r.pipeVerdict, 'amber');
});

test('missed: null (endpoint not queried) is unknown, not a false green', () => {
  const r = computeBackSync(baseInput({ missedShipments: null }), T, NOW);
  assert.equal(r.missedVerdict, 'unknown');
  assert.equal(r.pipeVerdict, 'unknown');
});

test('missedCountVerdict bands: null=>unknown, 0=>green, amber boundary, red boundary', () => {
  assert.equal(missedCountVerdict(null, 1, 5), 'unknown');
  assert.equal(missedCountVerdict(0, 1, 5), 'green');
  assert.equal(missedCountVerdict(1, 1, 5), 'amber');
  assert.equal(missedCountVerdict(4, 1, 5), 'amber');
  assert.equal(missedCountVerdict(5, 1, 5), 'red');
});

// --- Detail bag + rollup ---------------------------------------------------
test('detail carries the missed count, window, counters, rows and the has-work gate', () => {
  const r = computeBackSync(
    baseInput({
      missedShipments: missed(2),
      lastBackSyncAt: ago(2 * 3600),
      newestDtcShipmentAt: ago(600),
    }),
    T,
    NOW,
  );
  assert.equal(r.detail.missed_count, 2);
  assert.equal(r.detail.missed_window_days, 14);
  assert.equal(r.detail.fulfillments_last_24h, 231);
  assert.equal(r.detail.missed_shipments.length, 2);
  assert.equal(r.detail.last_back_sync_at, r.lastProgressAt);
  assert.equal(r.detail.has_unsynced_work, true);
  assert.equal(r.detail.newest_unsynced_shipment_at, ago(600));
});

test('rollup: all-healthy caught-up inputs produce a green pipe', () => {
  const r = computeBackSync(baseInput(), T, NOW);
  assert.equal(r.pipeVerdict, 'green');
});

test('rollup: unread inputs (missed null) produce unknown, not a false green or red', () => {
  const r = computeBackSync(
    {
      lastBackSyncAt: null,
      watcherHeartbeatAt: null,
      fulfillmentsLast24h: null,
      errorsLast24h: null,
      missedShipments: null,
      newestDtcShipmentAt: null,
    },
    T,
    NOW,
  );
  // With no detectable work the clocks read green, but the unread missed signal
  // carries the unknown so the pipe never falsely reads all-green.
  assert.equal(r.missedVerdict, 'unknown');
  assert.equal(r.pipeVerdict, 'unknown');
});
