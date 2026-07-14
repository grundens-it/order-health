// Round 3 integration tests for the order-layer classification (Units 1 + 2), driven
// through computeOrders against a SEEDED read-only board (no live NAV / Shopify). They
// prove: a Happy Return is excluded from awaiting_ship grading, and an FS-floored
// awaiting_ship order classifies fs_floor_at_zero with the FS + warehouse numbers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeOrders } from './writers.js';
import { happyReturnOrder, makeSeededSources, stuckStagingDtcOrder } from './seededBoard.js';

test('Unit 2: a Happy Return is reclassified out of awaiting_ship (green, classification return)', async () => {
  const now = Date.now();
  const sources = makeSeededSources({ now, orders: [happyReturnOrder('HR-HR23YXMM', now)] });
  const orders = await computeOrders(sources);
  const hr = orders.find((o) => o.nav_order_no === 'HR-HR23YXMM');
  assert.ok(hr);
  assert.equal(hr.order_verdict, 'green'); // not a red stall
  assert.notEqual(hr.current_stage, 'awaiting_ship');
  assert.equal(hr.classification, 'return');
  assert.match(hr.awaiting_ship_detail?.why ?? '', /Return|not an outbound/);
});

test('Unit 1: an FS-floored awaiting_ship order classifies fs_floor_at_zero with the numbers', async () => {
  const now = Date.now();
  const sources = makeSeededSources({
    now,
    orders: [stuckStagingDtcOrder('1002', now)], // 5-day-old unshipped DTC => awaiting_ship red
    orderLines: [{ orderNo: '1002', sku: 'A', location: 'TAC', outstandingQty: 1 }],
    inventoryAvailability: [{ sku: 'A', location: 'TAC', availableQty: 278 }], // warehouse stocked
    fsInventory: [{ sku: 'A', available: -1, onHand: 0, committed: 1 }], // FS floored negative
  });
  const orders = await computeOrders(sources);
  const o = orders.find((x) => x.nav_order_no === '1002');
  assert.ok(o);
  assert.equal(o.order_verdict, 'red'); // still a real stall
  assert.equal(o.classification, 'fs_floor_at_zero');
  assert.equal(o.awaiting_ship_detail?.fs_available, -1);
  assert.equal(o.awaiting_ship_detail?.nav_warehouse_on_hand, 278);
  assert.equal(o.awaiting_ship_detail?.sample_sku, 'A');
  assert.match(o.awaiting_ship_detail?.why ?? '', /FS floor-at-zero|re-floor/);
});

test('Unit 1: an in-stock awaiting_ship order with FS available >= 0 classifies genuine_3pl_delay', async () => {
  const now = Date.now();
  const sources = makeSeededSources({
    now,
    orders: [stuckStagingDtcOrder('1003', now)],
    orderLines: [{ orderNo: '1003', sku: 'B', location: 'TAC', outstandingQty: 1 }],
    inventoryAvailability: [{ sku: 'B', location: 'TAC', availableQty: 40 }],
    fsInventory: [{ sku: 'B', available: 8, onHand: 8, committed: 0 }], // FS healthy
  });
  const orders = await computeOrders(sources);
  const o = orders.find((x) => x.nav_order_no === '1003');
  assert.equal(o?.classification, 'genuine_3pl_delay');
});
