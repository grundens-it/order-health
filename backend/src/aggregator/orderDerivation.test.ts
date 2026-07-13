// Unit 6 (health-fidelity): the order-layer JOIN fix.
//
// These exercise buildOrderInput (the NAV-row -> hop-chain derivation) against
// REAL-NAV-shaped rows, where the middleware-sourced hop timestamps are null
// because read-only NAV cannot observe them. The bug they pin: reading those nulls
// as "never happened" reddened 98.9% of a healthy board. The fix infers the
// unobservable completions from NAV evidence, so a normally-progressing order reads
// GREEN while the true faults still fire. See
// docs/business/order-layer-red-rate-finding-2026-07-13.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOrderInput } from './writers.js';
import { gradeOrder, type OrderThresholds } from './orderLifecycle.js';
import type { NavOrderLifecycleRow } from '../sources/navClient.js';

const NOW = Date.parse('2026-07-13T18:00:00.000Z');
const T: OrderThresholds = {
  orphanGradingEnabled: false,
  stageAmberSeconds: 1800, // 30 min
  stageRedSeconds: 3600, // 60 min
  awaitingShipAmberSeconds: 86400, // 24 h
  awaitingShipRedSeconds: 259200, // 72 h
};

function ago(secondsAgo: number): string {
  return new Date(NOW - secondsAgo * 1000).toISOString();
}

// A row shaped exactly as the READ-ONLY NAV client maps it: the four
// middleware-sourced hop timestamps are null (unobservable from NAV).
function navRow(overrides: Partial<NavOrderLifecycleRow> = {}): NavOrderLifecycleRow {
  return {
    channel: 'dtc',
    navOrderNo: 'SP-320999',
    webId: 'web-320999',
    webOrder: 1,
    shopifyOrderName: '#320999',
    customerRef: 'CUST-1 Acme',
    shopifyOrderAt: ago(3 * 3600), // received 3h ago
    allocatorSplitAt: null, // middleware-sourced => null from NAV
    navStagingAt: null,
    navStagingStatus: null,
    navPromotionAt: null,
    navShipmentAt: null, // not shipped yet
    backSyncAt: null,
    missedBackSync: false,
    ...overrides,
  };
}

function grade(row: NavOrderLifecycleRow) {
  return gradeOrder(buildOrderInput(row), T, NOW);
}

// --- The core fidelity fix: a normally-progressing order reads GREEN --------
test('a DTC order received 3h ago, not yet shipped, reads GREEN (the live-run fix)', () => {
  const r = grade(navRow());
  assert.equal(r.order_verdict, 'green');
  // It is graded at the awaiting-ship frontier, not pinned at allocator_split.
  assert.equal(r.current_stage, 'awaiting_ship');
});

test('a shipped DTC order with all middleware timestamps null reads GREEN and complete', () => {
  const r = grade(navRow({ navShipmentAt: ago(2 * 3600) }));
  assert.equal(r.order_verdict, 'green');
  assert.equal(r.current_stage, 'complete');
});

// --- True faults still fire -------------------------------------------------
test('a DTC order not shipped for 6.8 days reds at the awaiting-ship SLO', () => {
  const r = grade(navRow({ shopifyOrderAt: ago(Math.round(6.8 * 86400)) }));
  assert.equal(r.order_verdict, 'red');
  assert.equal(r.current_stage, 'awaiting_ship');
});

test('a DTC order not shipped for 25h is amber (over 24h, under 72h)', () => {
  const r = grade(navRow({ shopifyOrderAt: ago(25 * 3600) }));
  assert.equal(r.order_verdict, 'amber');
});

test('a real NAV staging stuck row (Status 1, not shipped) reds the order', () => {
  const r = grade(navRow({ navStagingStatus: 1 }));
  assert.equal(r.order_verdict, 'red');
  assert.match(r.note ?? '', /NAV staging stuck/);
});

test('a shipped order flagged missed-back-sync reds at back_sync', () => {
  const r = grade(navRow({ navShipmentAt: ago(2 * 3600), missedBackSync: true }));
  assert.equal(r.order_verdict, 'red');
  assert.match(r.note ?? '', /Missed back-sync/);
});

test('a nonzero staging Status on an order that ALREADY shipped is not a fault', () => {
  // A shipped order clearly promoted; a stale Status must not red it.
  const r = grade(navRow({ navShipmentAt: ago(2 * 3600), navStagingStatus: 1 }));
  assert.equal(r.order_verdict, 'green');
});

// --- The 98.9% regression: a batch of healthy orders is not a sea of red ----
test('a batch of received-but-recent orders is overwhelmingly GREEN, not RED', () => {
  const rows = Array.from({ length: 20 }, (_, i) =>
    navRow({ navOrderNo: `SP-${320000 + i}`, shopifyOrderAt: ago((i + 1) * 900) }), // 15 min to 5h old
  );
  const graded = rows.map(grade);
  const red = graded.filter((o) => o.order_verdict === 'red').length;
  assert.equal(red, 0, 'no healthy recent order should read red');
  assert.ok(graded.every((o) => o.order_verdict === 'green'));
});

// --- Wholesale: unshipped reads unknown (not a false red) -------------------
test('an unshipped wholesale order with no anchor reads unknown, not a false red', () => {
  const r = grade(
    navRow({
      channel: 'wholesale',
      webId: null,
      webOrder: 0,
      shopifyOrderAt: null,
      navShipmentAt: null,
    }),
  );
  assert.notEqual(r.order_verdict, 'red');
});

test('a shipped wholesale order reads GREEN and complete', () => {
  const r = grade(
    navRow({
      channel: 'wholesale',
      webId: null,
      webOrder: 0,
      shopifyOrderAt: null,
      navShipmentAt: ago(2 * 3600),
    }),
  );
  assert.equal(r.order_verdict, 'green');
  assert.equal(r.current_stage, 'complete');
});
