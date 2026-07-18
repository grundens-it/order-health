// Verdict-correctness tests for the awaiting_ship classifier (Round 3, Unit 1). No
// I/O: every case feeds numbers and asserts the classification + the "why". The key
// boundary: a stocked-but-FS-floored order classifies fs_floor_at_zero (the bug),
// NOT genuine_3pl_delay, so it is never chased as a 3PL delay.
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAwaitingShip, type AwaitingShipClassInput } from './awaitingShipClass.js';

function base(overrides: Partial<AwaitingShipClassInput> = {}): AwaitingShipClassInput {
  return {
    ageS: 7 * 86400,
    fsAvailable: 5,
    navWarehouseOnHand: 100,
    sampleSku: 'NEPTUNE-L',
    hasNavOrder: true,
    hasShopifyOrder: true,
    isReturn: false,
    backorder: false,
    ...overrides,
  };
}

test('fs_floor_at_zero: FS available < 0 while a warehouse is stocked (the dominant bug)', () => {
  const r = classifyAwaitingShip(base({ fsAvailable: -1, navWarehouseOnHand: 278 }));
  assert.equal(r.classification, 'fs_floor_at_zero');
  assert.match(r.why, /FS floor-at-zero/);
  assert.match(r.why, /re-floor/);
  assert.equal(r.fs_available, -1);
  assert.equal(r.nav_warehouse_on_hand, 278);
});

test('fs_floor_at_zero is NOT a 3PL delay even when very old', () => {
  const r = classifyAwaitingShip(base({ fsAvailable: -3, navWarehouseOnHand: 12, ageS: 30 * 86400 }));
  assert.equal(r.classification, 'fs_floor_at_zero');
  assert.notEqual(r.classification, 'genuine_3pl_delay');
});

test('backordered: no FS bug, but a line is warehouse-short', () => {
  const r = classifyAwaitingShip(base({ fsAvailable: 0, navWarehouseOnHand: 0, backorder: true }));
  assert.equal(r.classification, 'backordered');
  assert.match(r.why, /restock/);
});

test('genuine_3pl_delay: in stock, FS available >= 0, unshipped past the SLO', () => {
  const r = classifyAwaitingShip(base({ fsAvailable: 8, navWarehouseOnHand: 50, backorder: false }));
  assert.equal(r.classification, 'genuine_3pl_delay');
  assert.match(r.why, /3PL delay/);
});

test('fs bug precedence: FS < 0 wins over a backorder flag (re-floor, not restock)', () => {
  const r = classifyAwaitingShip(base({ fsAvailable: -2, navWarehouseOnHand: 40, backorder: true }));
  assert.equal(r.classification, 'fs_floor_at_zero');
});

test('return: a Happy Return record is never an awaiting_ship stall', () => {
  const r = classifyAwaitingShip(base({ isReturn: true }));
  assert.equal(r.classification, 'return');
  assert.match(r.why, /Happy Return|not an outbound/);
});

test('orphan_or_return: no NAV order and no Shopify order behind the record', () => {
  const r = classifyAwaitingShip(base({ hasNavOrder: false, hasShopifyOrder: false }));
  assert.equal(r.classification, 'orphan_or_return');
});

test('unread FS (null) with stock does not falsely read fs_floor_at_zero', () => {
  // FS not read yet: cannot assert the bug; falls through to 3PL delay (in stock).
  const r = classifyAwaitingShip(base({ fsAvailable: null }));
  assert.equal(r.classification, 'genuine_3pl_delay');
});
