// Unit 8 INTEGRATION tests: whole-board verdict correctness against seeded rows.
//
// Unlike the per-module unit tests (which exercise one pure compute in isolation),
// these drive the REAL layer runners end to end: computePipelines + computeOrders
// off a SEEDED read-only Sources (no live NAV, no middleware call), then feed both
// row sets into computeRollup and into the transition diff. The assertion is that
// the assembled per-pipe verdicts, the order rollup, and the leadership headline
// are JOINTLY correct for a whole board (design.md 3 / 5 / 6, QA seat).
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PipelineHealth, Verdict } from '@order-health/shared';
import { computeOrders, computePipelines } from './writers.js';
import { computeRollup } from './rollup.js';
import { diffTransitions, type VerdictSubject } from './transitions.js';
import {
  greenDtcOrder,
  greenWholesaleOrder,
  makeSeededSources,
  stuckStagingDtcOrder,
} from './seededBoard.js';
import type { MissedShipment } from '@order-health/shared';

function byPipe(pipes: PipelineHealth[], key: string): PipelineHealth {
  const p = pipes.find((x) => x.pipe === key);
  assert.ok(p, `pipe ${key} present in the assembled board`);
  return p;
}

function pipeSubjects(pipes: PipelineHealth[]): VerdictSubject[] {
  return pipes.map((p) => ({ subjectKind: 'pipe' as const, subjectKey: p.pipe, verdict: p.pipe_verdict }));
}

function missed(n: number): MissedShipment[] {
  return Array.from({ length: n }, (_, i) => ({
    order_ref: `#${5000 + i}`,
    web_id: `web-${5000 + i}`,
    nav_shipment_no: `SHP-${9000 + i}`,
    carrier: 'UPS',
    tracking: null,
    posted_at: null,
    age_s: 30_000,
    reason: 'no shopify_fulfillment_id',
  }));
}

// --- All-green board: healthy headline --------------------------------------
test('all-green board: every one of the nine pipes is green and the headline is healthy/green', async () => {
  const now = Date.now();
  const sources = makeSeededSources({
    now,
    orders: [greenDtcOrder('1001', now), greenWholesaleOrder('2050', now)],
  });

  const pipes = await computePipelines(sources);
  const orders = await computeOrders(sources);
  const rollup = computeRollup(pipes, orders);

  // Every pipe in the fixed strip order is present and green (WI1 oos_held + WI2
  // fs_location_divergence are added additively; their seeded defaults are green).
  assert.equal(pipes.length, 9);
  for (const key of [
    'inventory_sync',
    'back_sync',
    'price_sync',
    'nav_job_queue',
    'shopify_webhook',
    'allocator',
    'oos_held',
    'fs_location_divergence',
    'order_handoff',
  ]) {
    assert.equal(byPipe(pipes, key).pipe_verdict, 'green', `${key} green`);
  }
  // inventory_sync's three sub-verdicts are each green (freshness + liveness green).
  const inv = byPipe(pipes, 'inventory_sync');
  assert.equal(inv.freshness_verdict, 'green');
  assert.equal(inv.liveness_verdict, 'green');

  // Both orders graded green; the whole board rolls up healthy.
  assert.equal(orders.length, 2);
  assert.ok(orders.every((o) => o.order_verdict === 'green'));
  assert.equal(rollup.headline, 'healthy');
  assert.equal(rollup.headline_verdict, 'green');
  assert.equal(rollup.oldest_stuck_age_s, null);
  assert.equal(rollup.inventory_freshness, 'green');
});

// --- One red pipe drives the headline to stuck ------------------------------
test('one red pipe (back_sync missed-shipments backlog) drives the headline to stuck, other pipes stay green', async () => {
  const now = Date.now();
  const sources = makeSeededSources({
    now,
    backSync: { missed: missed(6) }, // >= missedRedCount (5) => missed verdict RED
    orders: [greenDtcOrder('1001', now)],
  });

  const pipes = await computePipelines(sources);
  const orders = await computeOrders(sources);
  const rollup = computeRollup(pipes, orders);

  assert.equal(byPipe(pipes, 'back_sync').pipe_verdict, 'red');
  // The other pipes are unaffected: the red is isolated to back_sync.
  assert.equal(byPipe(pipes, 'inventory_sync').pipe_verdict, 'green');
  assert.equal(byPipe(pipes, 'allocator').pipe_verdict, 'green');

  assert.equal(rollup.headline, 'stuck');
  assert.equal(rollup.headline_verdict, 'red');
  assert.equal(rollup.counts.pipes_red, 1);
});

// --- Wholesale is first-class and never orphan-flags ------------------------
test('a wholesale order is graded on its NAV-only chain and NEVER orphan-flags', async () => {
  const now = Date.now();
  const sources = makeSeededSources({
    now,
    orders: [greenWholesaleOrder('2050', now), greenWholesaleOrder('2051', now)],
  });

  const orders = await computeOrders(sources);
  assert.equal(orders.length, 2);
  for (const o of orders) {
    assert.equal(o.channel, 'wholesale');
    // No Shopify leg to grade, so it is never an orphan and shows no Shopify id.
    assert.equal(o.is_orphan_suspect, false);
    assert.equal(o.shopify_order_id, null);
    assert.equal(o.shopify_order_name, null);
    assert.equal(o.order_verdict, 'green');
    assert.equal(o.current_stage, 'complete');
  }
});

// --- A genuinely stalled DTC order reds the order layer and the headline -----
// Round 4: "stalled" now means a real HANDOFF DEFECT, not elapsed time. This order is
// released with stock on hand and no EDI 940 was ever cut, so it never reached Holman:
// that is ours, and it alone must drive the headline. (An order merely sitting past a
// ship SLO no longer reds anything; that was the old model that produced fake numbers.)
test('a DTC order whose handoff failed reds the order layer and drives the headline stuck with the oldest-stuck age', async () => {
  const now = Date.now();
  const sources = makeSeededSources({
    now,
    orders: [greenDtcOrder('1001', now), { ...stuckStagingDtcOrder('1002', now), navStatus: 1 }],
    orderLines: [{ orderNo: '1002', sku: 'A', location: 'HF1FTZ', outstandingQty: 1 }],
    inventoryAvailability: [{ sku: 'A', location: 'HF1FTZ', availableQty: 50 }],
    fsInventory: [{ sku: 'A', available: 7, onHand: 7, committed: 0 }], // FS healthy: not the floor bug
    ediHandoff: [], // no 940 at all: the handoff never happened
  });

  const pipes = await computePipelines(sources); // all pipes green
  const orders = await computeOrders(sources);
  const rollup = computeRollup(pipes, orders);

  const stuck = orders.find((o) => o.nav_order_no === '1002');
  assert.ok(stuck);
  assert.equal(stuck.order_verdict, 'red');
  assert.equal(stuck.current_stage, 'awaiting_ship'); // stalled awaiting shipment, past the SLO

  // No SYNC pipe is red, yet the red ORDER alone drives the headline to stuck. The
  // order_handoff pipe is excluded from this check on purpose: it grades the very same
  // defect from the same facts, so it reds with the order, by design.
  assert.ok(pipes.filter((p) => p.pipe !== 'order_handoff').every((p) => p.pipe_verdict === 'green'));
  assert.equal(rollup.headline, 'stuck');
  assert.equal(rollup.headline_verdict, 'red');
  // Oldest stuck age reflects the days-old unshipped order (past the 72h red band).
  assert.ok((rollup.oldest_stuck_age_s ?? 0) > 72 * 3600, 'oldest stuck age reflects the stalled order');
});

// --- Transition diff is jointly correct across the board --------------------
test('transition diff: a green->red board OPENS exactly one pipe transition; the recovery RESOLVES it', async () => {
  const now = Date.now();
  const healthy = await computePipelines(makeSeededSources({ now }));
  const degraded = await computePipelines(
    makeSeededSources({ now, backSync: { missed: missed(6) } }),
  );

  const asOf = new Date(now).toISOString();

  // Green -> red: open a single transition for back_sync, nothing else.
  const openActions = diffTransitions(pipeSubjects(healthy), pipeSubjects(degraded), [], asOf);
  assert.equal(openActions.length, 1);
  assert.equal(openActions[0]!.op, 'open');
  assert.equal(openActions[0]!.subjectKey, 'back_sync');

  // Red -> green with that row open: resolve it, and only it.
  const resolveActions = diffTransitions(
    pipeSubjects(degraded),
    pipeSubjects(healthy),
    [{ subjectKind: 'pipe', subjectKey: 'back_sync' }],
    asOf,
  );
  assert.equal(resolveActions.length, 1);
  assert.equal(resolveActions[0]!.op, 'resolve');
  assert.equal(resolveActions[0]!.subjectKey, 'back_sync');
});

// Guard against an accidental verdict-enum drift breaking the joint assertions.
test('every assembled pipe carries a valid verdict enum', async () => {
  const pipes = await computePipelines(makeSeededSources());
  const valid: Verdict[] = ['green', 'amber', 'red', 'unknown'];
  for (const p of pipes) {
    assert.ok(valid.includes(p.pipe_verdict), `${p.pipe} verdict in enum`);
    assert.ok(valid.includes(p.freshness_verdict));
    assert.ok(valid.includes(p.liveness_verdict));
  }
});
