// Verdict-correctness tests for the order-lifecycle grader (design.md 3.1 / 5,
// QA seat). No live NAV / middleware: every case is a SEEDED input through the
// pure gradeOrder / computeOrderRows. Run with `npm test` (node:test).
//
// Covers: DTC full-chain grading, wholesale grading with no Shopify leg (and NOT
// flagged an orphan), the orphan flag OFF vs ON behaviour, and channel filtering.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrderHealth } from '@order-health/shared';
import {
  computeOrderRows,
  filterOrdersByChannel,
  gradeOrder,
  type OrderHop,
  type OrderInput,
  type OrderThresholds,
} from './orderLifecycle.js';

// Fixed clock so every age is deterministic.
const NOW = Date.parse('2026-07-05T18:00:00.000Z');

// Defaults mirror config.order: staging 30m/60m, awaiting-ship 24h/72h, orphan OFF.
const T: OrderThresholds = {
  orphanGradingEnabled: false,
  stageAmberSeconds: 1800,
  stageRedSeconds: 3600,
  awaitingShipAmberSeconds: 86400,
  awaitingShipRedSeconds: 259200,
};

// Orphan grading ON (post BA question 1).
const T_ORPHAN: OrderThresholds = { ...T, orphanGradingEnabled: true };

// An ISO timestamp `secondsAgo` before NOW.
function ago(secondsAgo: number): string {
  return new Date(NOW - secondsAgo * 1000).toISOString();
}

function hop(
  stage: OrderHop['stage'],
  completedAt: string | null,
  enteredAt: string | null = null,
  error: string | null = null,
): OrderHop {
  return { stage, completedAt, enteredAt, error };
}

// A fully-shipped, back-synced DTC order: every hop completed in order.
function dtcComplete(overrides: Partial<OrderInput> = {}): OrderInput {
  return {
    channel: 'dtc',
    navOrderNo: 'SO-1001',
    shopifyOrderName: '#1024',
    customerRef: 'web-cust',
    webId: 'gid://shopify/Order/5551024',
    webOrder: 1, // a genuine web order (WebOrder = 1 on the NAV Sales Header)
    hops: [
      hop('shopify_order', ago(9000), ago(9100)),
      hop('allocator_split', ago(8800), ago(9000)),
      hop('nav_staging', ago(8600), ago(8800)),
      hop('nav_promotion', ago(8400), ago(8600)),
      hop('awaiting_ship', ago(3600), ago(8400)),
      hop('nav_shipment', ago(3600), ago(3600)),
      hop('back_sync', ago(1800), ago(3600)),
    ],
    ...overrides,
  };
}

// --- DTC full-chain grading -----------------------------------------------
test('DTC: fully shipped and back-synced order is green and complete', () => {
  const r = gradeOrder(dtcComplete(), T, NOW);
  assert.equal(r.channel, 'dtc');
  assert.equal(r.order_verdict, 'green');
  assert.equal(r.current_stage, 'complete');
  assert.equal(r.oldest_stuck_age_s, null);
  assert.equal(r.is_orphan_suspect, false);
  assert.equal(r.shopify_order_id, 'gid://shopify/Order/5551024');
});

test('DTC: order stuck awaiting promotion past the red SLO reds the order', () => {
  // Staged, entered nav_promotion 2h ago, not yet promoted => past 60m red band.
  const input: OrderInput = {
    channel: 'dtc',
    navOrderNo: 'SO-1002',
    shopifyOrderName: '#1025',
    customerRef: 'web-cust',
    webId: 'gid://shopify/Order/5551025',
    hops: [
      hop('shopify_order', ago(9000), ago(9100)),
      hop('allocator_split', ago(8800), ago(9000)),
      hop('nav_staging', ago(7200), ago(8800)),
      hop('nav_promotion', null, ago(7200)), // pending 2h => red
    ],
  };
  const r = gradeOrder(input, T, NOW);
  assert.equal(r.order_verdict, 'red');
  assert.equal(r.current_stage, 'nav_promotion');
  assert.equal(r.oldest_stuck_age_s, 7200);
});

test('DTC: in-flight within SLO is amber, not red or unknown', () => {
  const input: OrderInput = {
    channel: 'dtc',
    navOrderNo: 'SO-1003',
    shopifyOrderName: '#1026',
    customerRef: 'web-cust',
    webId: 'w-1026',
    hops: [
      hop('shopify_order', ago(4000), ago(4100)),
      hop('allocator_split', ago(3800), ago(4000)),
      hop('nav_staging', ago(3600), ago(3800)),
      hop('nav_promotion', null, ago(2400)), // 40m: over 30m amber, under 60m red
    ],
  };
  const r = gradeOrder(input, T, NOW);
  assert.equal(r.order_verdict, 'amber');
  assert.equal(r.current_stage, 'nav_promotion');
});

test('DTC: a latched staging error reds the order regardless of age', () => {
  const input: OrderInput = {
    channel: 'dtc',
    navOrderNo: 'SO-1004',
    shopifyOrderName: '#1027',
    customerRef: 'web-cust',
    webId: 'w-1027',
    hops: [
      hop('shopify_order', ago(1000), ago(1100)),
      hop('allocator_split', ago(900), ago(1000)),
      hop('nav_staging', null, ago(300), 'NAV staging stuck (Status 1)'), // fresh but errored
    ],
  };
  const r = gradeOrder(input, T, NOW);
  assert.equal(r.order_verdict, 'red');
  assert.equal(r.current_stage, 'nav_staging');
  assert.equal(r.note, 'NAV staging stuck (Status 1)');
});

test('DTC: future hops (not yet reached) do not drag a healthy order to unknown', () => {
  // Only reached nav_promotion (fresh, green); later hops are ungraded futures.
  const input: OrderInput = {
    channel: 'dtc',
    navOrderNo: 'SO-1005',
    shopifyOrderName: '#1028',
    customerRef: 'web-cust',
    webId: 'w-1028',
    hops: [
      hop('shopify_order', ago(600), ago(700)),
      hop('allocator_split', ago(500), ago(600)),
      hop('nav_staging', ago(400), ago(500)),
      hop('nav_promotion', null, ago(60)), // 1m in, well under amber => green
    ],
  };
  const r = gradeOrder(input, T, NOW);
  assert.equal(r.order_verdict, 'green');
  assert.equal(r.current_stage, 'nav_promotion');
});

// --- Wholesale grading: no Shopify leg, never an orphan -------------------
test('wholesale: shipped order is green with no Shopify-leg identity', () => {
  const input: OrderInput = {
    channel: 'wholesale',
    navOrderNo: 'WS-2001',
    shopifyOrderName: null,
    customerRef: 'CUST-4400',
    webId: '', // wholesale correctly has NO WebId
    hops: [
      hop('nav_promotion', ago(9000), ago(9100)),
      hop('awaiting_ship', ago(3600), ago(9000)),
      hop('nav_shipment', ago(3600), ago(3600)),
    ],
  };
  const r = gradeOrder(input, T, NOW);
  assert.equal(r.channel, 'wholesale');
  assert.equal(r.order_verdict, 'green');
  assert.equal(r.current_stage, 'complete');
  assert.equal(r.is_orphan_suspect, false);
  // No Shopify leg surfaced for wholesale.
  assert.equal(r.shopify_order_id, null);
  assert.equal(r.shopify_order_name, null);
});

test('wholesale: empty WebId is NEVER an orphan, even with orphan grading ON', () => {
  const input: OrderInput = {
    channel: 'wholesale',
    navOrderNo: 'WS-2002',
    shopifyOrderName: null,
    customerRef: 'CUST-4401',
    webId: '', // empty, but this is wholesale, not an orphan
    hops: [
      hop('nav_promotion', ago(9000), ago(9100)),
      hop('awaiting_ship', null, ago(9000)), // in-flight within 24h SLO => green
    ],
  };
  const r = gradeOrder(input, T_ORPHAN, NOW);
  assert.equal(r.is_orphan_suspect, false);
  assert.notEqual(r.order_verdict, 'red');
});

test('wholesale: awaiting ship past the 72h SLO reds the order', () => {
  const input: OrderInput = {
    channel: 'wholesale',
    navOrderNo: 'WS-2003',
    shopifyOrderName: null,
    customerRef: 'CUST-4402',
    webId: '',
    hops: [
      hop('nav_promotion', ago(4 * 86400), ago(4 * 86400 + 100)),
      hop('awaiting_ship', null, ago(4 * 86400)), // 4 days waiting => red
    ],
  };
  const r = gradeOrder(input, T, NOW);
  assert.equal(r.order_verdict, 'red');
  assert.equal(r.current_stage, 'awaiting_ship');
});

// --- Orphan flag OFF vs ON -------------------------------------------------
test('orphan flag OFF: a DTC order with an empty WebId is NOT flagged and NOT reded', () => {
  const input: OrderInput = {
    channel: 'dtc',
    navOrderNo: 'SO-3001',
    shopifyOrderName: '#1030',
    customerRef: 'web-cust',
    webId: '', // empty WebId
    hops: [
      hop('shopify_order', ago(600), ago(700)),
      hop('allocator_split', null, ago(120)), // fresh, green
    ],
  };
  const r = gradeOrder(input, T, NOW);
  assert.equal(r.is_orphan_suspect, false);
  assert.equal(r.order_verdict, 'green');
});

test('orphan flag ON: a DTC WebOrder=1 order with an empty WebId is flagged and reded', () => {
  const input: OrderInput = {
    channel: 'dtc',
    navOrderNo: 'SO-3002',
    shopifyOrderName: '#1031',
    customerRef: 'web-cust',
    webId: '   ', // whitespace counts as empty
    webOrder: 1, // a web order that lost its WebId => genuine orphan (DATA_SOURCES)
    hops: [
      hop('shopify_order', ago(600), ago(700)),
      hop('allocator_split', null, ago(120)), // otherwise green
    ],
  };
  const r = gradeOrder(input, T_ORPHAN, NOW);
  assert.equal(r.is_orphan_suspect, true);
  assert.equal(r.order_verdict, 'red');
  assert.match(r.note ?? '', /orphan suspect/);
});

test('orphan flag ON: a DTC order WITH a WebId is not an orphan', () => {
  const r = gradeOrder(dtcComplete({ webId: 'w-present' }), T_ORPHAN, NOW);
  assert.equal(r.is_orphan_suspect, false);
  assert.equal(r.order_verdict, 'green');
});

test('orphan flag ON: an empty WebId with WebOrder=0 is NEVER an orphan', () => {
  // WebOrder = 0 => not a web order (wholesale / manual). Even if the row is
  // labelled dtc and the flag is ON, WebOrder=0 must never be graded an orphan.
  const input: OrderInput = {
    channel: 'dtc',
    navOrderNo: 'SO-3003',
    shopifyOrderName: '#1032',
    customerRef: 'web-cust',
    webId: '', // empty
    webOrder: 0, // not a web order => never an orphan
    hops: [
      hop('shopify_order', ago(600), ago(700)),
      hop('allocator_split', null, ago(120)), // otherwise green
    ],
  };
  const r = gradeOrder(input, T_ORPHAN, NOW);
  assert.equal(r.is_orphan_suspect, false);
  assert.notEqual(r.order_verdict, 'red');
});

test('orphan flag ON: an empty WebId with WebOrder unset is not an orphan', () => {
  // Defensive: an undefined WebOrder (source not reporting) is not treated as a
  // web order, so it cannot be mis-graded an orphan.
  const input: OrderInput = {
    channel: 'dtc',
    navOrderNo: 'SO-3004',
    shopifyOrderName: '#1033',
    customerRef: 'web-cust',
    webId: '',
    hops: [
      hop('shopify_order', ago(600), ago(700)),
      hop('allocator_split', null, ago(120)),
    ],
  };
  const r = gradeOrder(input, T_ORPHAN, NOW);
  assert.equal(r.is_orphan_suspect, false);
  assert.notEqual(r.order_verdict, 'red');
});

// --- Channel filtering (mirrors the read-API SQL WHERE) -------------------
test('channel filter: all / dtc / wholesale select the right rows', () => {
  const rows: OrderHealth[] = computeOrderRows(
    [
      dtcComplete({ navOrderNo: 'SO-A' }),
      {
        channel: 'wholesale',
        navOrderNo: 'WS-A',
        shopifyOrderName: null,
        customerRef: 'CUST-9',
        webId: '',
        hops: [hop('nav_promotion', ago(5000), ago(5100)), hop('awaiting_ship', null, ago(5000))],
      },
    ],
    T,
    NOW,
  );

  assert.equal(filterOrdersByChannel(rows, 'all').length, 2);
  assert.deepEqual(
    filterOrdersByChannel(rows, 'dtc').map((r) => r.channel),
    ['dtc'],
  );
  assert.deepEqual(
    filterOrdersByChannel(rows, 'wholesale').map((r) => r.channel),
    ['wholesale'],
  );
});
