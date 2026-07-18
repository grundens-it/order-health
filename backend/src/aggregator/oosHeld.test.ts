// Verdict-correctness + routing tests for the OOS-held backlog monitor
// (WI1 #87 + WI3 #89). No live middleware / NAV: every case is a SEEDED input
// through the pure computeOosHeld / routeHeldOrder. Run with `npm test` (node:test).
import assert from 'node:assert/strict';
import test from 'node:test';
import type { OosHeldOrder } from '@order-health/shared';
import {
  FORWARD_SYNC_REPLAY_TOOL,
  NAV_LINE_ADD_TOOL,
  STALE_HOLD_CLEAR_TOOL,
  bucketHeldOrder,
  computeOosHeld,
  extractDroppedSku,
  routeHeldOrder,
  type HeldNavFacts,
  type OosHeldThresholds,
} from './oosHeld.js';

const NOW = Date.parse('2026-07-18T18:00:00.000Z');

// Mirrors config.oosHeld: depth amber 25 / red 100; age amber 24h / red 72h.
const T: OosHeldThresholds = {
  depthAmberCount: 25,
  depthRedCount: 100,
  ageAmberSeconds: 86_400,
  ageRedSeconds: 259_200,
};

function ago(seconds: number): string {
  return new Date(NOW - seconds * 1000).toISOString();
}

function held(overrides: Partial<OosHeldOrder> = {}): OosHeldOrder {
  return {
    order_id: '5551212',
    order_name: 'SP-322348',
    held_class: 'transient',
    status: 'pending',
    attempts: 2,
    first_seen_at: ago(3600),
    last_attempt_at: ago(300),
    last_detail: 'OutOfStock 50625-425',
    age_s: null,
    nav_bucket: null,
    remediation_tool_id: null,
    ...overrides,
  };
}

// Build N alerting (transient, not-resolved) rows.
function manyHeld(n: number, overrides: Partial<OosHeldOrder> = {}): OosHeldOrder[] {
  return Array.from({ length: n }, (_, i) => held({ order_name: `SP-${400000 + i}`, ...overrides }));
}

// --- WI3: the duplicate-skip routing rule (the gotcha this test pins) -------
test('routing: a NOT-in-NAV held order routes to forward_sync_replay (valid re-drive)', () => {
  const route = routeHeldOrder({ inNav: false, droppedSku: '50625-425', navLineSkus: [] });
  assert.equal(route.bucket, 'not_in_nav');
  assert.equal(route.toolId, FORWARD_SYNC_REPLAY_TOOL);
});

test('routing: an in-NAV order with the dropped line MISSING routes to the NAV line-add, never a re-drive', () => {
  const route = routeHeldOrder({ inNav: true, droppedSku: '50625-425', navLineSkus: ['99999-000'] });
  assert.equal(route.bucket, 'in_nav_line_missing');
  assert.equal(route.toolId, NAV_LINE_ADD_TOOL);
  assert.notEqual(route.toolId, FORWARD_SYNC_REPLAY_TOOL);
});

test('routing: an in-NAV order with the line PRESENT routes to the stale-hold clear, never a re-drive', () => {
  const route = routeHeldOrder({ inNav: true, droppedSku: '50625-425', navLineSkus: ['50625-425'] });
  assert.equal(route.bucket, 'in_nav_line_present');
  assert.equal(route.toolId, STALE_HOLD_CLEAR_TOOL);
  assert.notEqual(route.toolId, FORWARD_SYNC_REPLAY_TOOL);
});

test('duplicate-skip invariant: NO in-NAV held order EVER routes to forward_sync_replay', () => {
  // The middleware returns DuplicateSkip when allocations exist AND the order is in
  // NAV, so a re-drive no-ops. Every in-NAV variant must avoid forward_sync_replay.
  const inNavVariants: HeldNavFacts[] = [
    { inNav: true, droppedSku: '50625-425', navLineSkus: [] },          // line missing
    { inNav: true, droppedSku: '50625-425', navLineSkus: ['50625-425'] }, // line present
    { inNav: true, droppedSku: null, navLineSkus: [] },                 // sku unknown -> present (verify)
    { inNav: true, droppedSku: null, navLineSkus: ['A', 'B'] },
  ];
  for (const facts of inNavVariants) {
    const route = routeHeldOrder(facts);
    assert.notEqual(route.toolId, FORWARD_SYNC_REPLAY_TOOL, `in-NAV must not re-drive: ${JSON.stringify(facts)}`);
    assert.ok(route.bucket === 'in_nav_line_missing' || route.bucket === 'in_nav_line_present');
  }
});

test('bucketHeldOrder attaches the bucket + tool without mutating the input row', () => {
  const row = held();
  const out = bucketHeldOrder(row, { inNav: false, droppedSku: '50625-425', navLineSkus: [] });
  assert.equal(out.nav_bucket, 'not_in_nav');
  assert.equal(out.remediation_tool_id, FORWARD_SYNC_REPLAY_TOOL);
  assert.equal(row.nav_bucket, null); // original untouched
});

test('extractDroppedSku pulls a style token from last_detail, else null', () => {
  assert.equal(extractDroppedSku('OutOfStock 50625-425 at HF1FTZ'), '50625-425');
  assert.equal(extractDroppedSku('no sku here'), null);
  assert.equal(extractDroppedSku(null), null);
});

// --- WI1: depth band over the alerting population ---------------------------
test('depth: a queue under the amber count is green', () => {
  const r = computeOosHeld({ heldOrders: manyHeld(24) }, T, NOW);
  assert.equal(r.heldVerdict, 'green');
  assert.equal(r.detail.alerting_count, 24);
});

test('depth: a queue at the amber count is amber', () => {
  const r = computeOosHeld({ heldOrders: manyHeld(25) }, T, NOW);
  assert.equal(r.heldVerdict, 'amber');
});

test('depth: a queue at the red count is red', () => {
  const r = computeOosHeld({ heldOrders: manyHeld(100) }, T, NOW);
  assert.equal(r.heldVerdict, 'red');
  assert.equal(r.detail.alerting_count, 100);
});

// --- WI1: age band over the needs_operator rows -----------------------------
test('age: a needs_operator row at the amber age ambers even with a tiny queue', () => {
  const r = computeOosHeld(
    { heldOrders: [held({ status: 'needs_operator', first_seen_at: ago(86_400) })] },
    T,
    NOW,
  );
  assert.equal(r.detail.alerting_count, 1); // depth green
  assert.equal(r.heldVerdict, 'amber');     // age drives it
  assert.equal(r.detail.oldest_alerting_age_s, 86_400);
});

test('age: a needs_operator row at the red age reds', () => {
  const r = computeOosHeld(
    { heldOrders: [held({ status: 'needs_operator', first_seen_at: ago(259_200) })] },
    T,
    NOW,
  );
  assert.equal(r.heldVerdict, 'red');
});

// --- WI1: backorder-class rows are legitimate and NEVER drive red -----------
test('backorder rows never drive the verdict: a huge, old backorder pile stays green', () => {
  const backorders = Array.from({ length: 200 }, (_, i) =>
    held({
      order_name: `SP-${900000 + i}`,
      held_class: 'backorder',
      status: 'needs_operator',
      first_seen_at: ago(20 * 86_400), // 20 days old
    }),
  );
  const r = computeOosHeld({ heldOrders: backorders }, T, NOW);
  assert.equal(r.heldVerdict, 'green');
  assert.equal(r.detail.alerting_count, 0);       // backorders are not alerting
  assert.equal(r.detail.needs_operator_count, 0); // nor needs_operator (that is transient-only)
  assert.equal(r.detail.backorder_count, 200);    // surfaced separately
});

// --- WI1: resolved rows drop out of the alerting population ------------------
test('resolved transient rows do not count toward the depth', () => {
  const rows = [...manyHeld(30), ...manyHeld(10, { status: 'resolved' })];
  const r = computeOosHeld({ heldOrders: rows }, T, NOW);
  assert.equal(r.detail.total_count, 40);
  assert.equal(r.detail.alerting_count, 30); // only the not-resolved transient rows
});

// --- WI1: the 2026-07-17 incident level reds -------------------------------
test('the 2026-07-17 backlog (~173 transient held) reds the pipe', () => {
  // 40 not-in-NAV pending, 52 in-NAV line-missing needs_operator, 81 in-NAV line-present.
  const rows: OosHeldOrder[] = [
    ...manyHeld(40, { status: 'pending' }),
    ...manyHeld(52, { status: 'needs_operator', first_seen_at: ago(2 * 86_400) }),
    ...manyHeld(81, { status: 'needs_operator', first_seen_at: ago(4 * 86_400) }),
  ];
  const r = computeOosHeld({ heldOrders: rows }, T, NOW);
  assert.equal(r.detail.total_count, 173);
  assert.equal(r.heldVerdict, 'red'); // depth (173 >= 100) AND age (4d >= 72h) both red
});

// --- WI1: unread source is unknown, never a false green ---------------------
test('a null held source grades unknown, not a false green', () => {
  const r = computeOosHeld({ heldOrders: null }, T, NOW);
  assert.equal(r.heldVerdict, 'unknown');
  assert.equal(r.detail.total_count, null);
  assert.equal(r.detail.alerting_count, null);
});

// --- WI1 + WI3: bucket tallies surface once the rows are routed --------------
test('bucket tallies are filled once the rows carry a nav_bucket, and reason_counts tallies last_detail', () => {
  const rows = [
    bucketHeldOrder(held({ order_name: 'SP-1' }), { inNav: false, droppedSku: '50625-425', navLineSkus: [] }),
    bucketHeldOrder(held({ order_name: 'SP-2' }), { inNav: true, droppedSku: '50625-425', navLineSkus: [] }),
    bucketHeldOrder(held({ order_name: 'SP-3' }), { inNav: true, droppedSku: '50625-425', navLineSkus: ['50625-425'] }),
  ];
  const r = computeOosHeld({ heldOrders: rows }, T, NOW);
  assert.equal(r.detail.not_in_nav_count, 1);
  assert.equal(r.detail.in_nav_line_missing_count, 1);
  assert.equal(r.detail.in_nav_line_present_count, 1);
  assert.equal(r.detail.reason_counts['OutOfStock 50625-425'], 3);
});
