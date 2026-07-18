// Pure-surface tests for the read-only middleware HTTP client (no live fetch).
//
// Covers the parts testable without a live middleware (design.md QA seat):
//   1. the per-endpoint JSON mappers  -> a fake response body shaped like the
//      REAL middleware handler maps to the EXACT typed shape the MiddlewareClient
//      interface declares (issues #36 / #37: real routes + compose logic);
//   2. the read-only GET guard + the URL / header / query builders (Bearer only
//      when a token is set);
//   3. the factory's live-vs-stub selection driven by MIDDLEWARE_BASE_URL.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIDDLEWARE_PATHS,
  MiddlewareClientStub,
  asRecord,
  asRecordArray,
  assertReadOnlyMethod,
  buildHeaders,
  buildPath,
  buildUrl,
  mapAllocationDecision,
  mapAllocatorStatus,
  mapBackSyncStatus,
  mapInventorySyncFeed,
  mapInventorySyncStatus,
  countAtpFallbacks,
  isAllocationErrorRow,
  deriveAllocatorFailedCount,
  mapJobQueueHealthStatus,
  mapMissedShipments,
  mapPriceSyncStatus,
  mapShopifyWebhookStatus,
  mapWebhookTopic,
  createMiddlewareClient,
} from './middlewareClient.js';
import { config } from '../config.js';

// --- Read-only GET guard ----------------------------------------------------
test('assertReadOnlyMethod accepts GET and rejects any mutating verb', () => {
  assert.doesNotThrow(() => assertReadOnlyMethod('GET'));
  assert.doesNotThrow(() => assertReadOnlyMethod('get'));
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    assert.throws(() => assertReadOnlyMethod(verb), /non-GET/);
  }
});

// --- URL + header + query builders ------------------------------------------
test('buildUrl joins base + path without doubling the slash', () => {
  assert.equal(buildUrl('https://middleware.grundens.com', '/api/errors'),
    'https://middleware.grundens.com/api/errors');
  assert.equal(buildUrl('https://middleware.grundens.com/', '/api/errors'),
    'https://middleware.grundens.com/api/errors');
});

test('buildPath appends a query string and skips undefined values', () => {
  assert.equal(buildPath('/api/activity/recent'), '/api/activity/recent');
  assert.equal(buildPath('/api/activity/recent', { limit: 200 }), '/api/activity/recent?limit=200');
  assert.equal(buildPath('/api/errors', { days: 15, page: undefined }), '/api/errors?days=15');
});

test('buildHeaders sends Bearer ONLY when a token is set (endpoints are unauthenticated)', () => {
  const none = buildHeaders('');
  assert.equal(none.Accept, 'application/json');
  assert.equal(none.Authorization, undefined);
  const withToken = buildHeaders('ro-token');
  assert.equal(withToken.Authorization, 'Bearer ro-token');
});

// --- Body coercion helpers --------------------------------------------------
test('asRecordArray tolerates bare arrays and real middleware envelopes', () => {
  assert.deepEqual(asRecordArray([{ a: 1 }]), [{ a: 1 }]);
  assert.deepEqual(asRecordArray({ rows: [{ b: 2 }] }), [{ b: 2 }]); // errors / stuck-staging / recent / audit
  assert.deepEqual(asRecordArray({ missed: [{ c: 3 }] }), [{ c: 3 }]); // missed-shipments
  assert.deepEqual(asRecordArray({ pending: [{ d: 4 }] }), [{ d: 4 }]); // pending-fulfillment
  assert.deepEqual(asRecordArray({ events: [{ e: 5 }] }), [{ e: 5 }]); // webhook events
  assert.deepEqual(asRecordArray(null), []);
  assert.deepEqual(asRecordArray('nope'), []);
});

test('asRecord returns objects and coerces non-objects to {}', () => {
  assert.deepEqual(asRecord({ a: 1 }), { a: 1 });
  assert.deepEqual(asRecord([1, 2]), {});
  assert.deepEqual(asRecord(null), {});
});

// --- GET /api/nav/inventory-sync/analytics ----------------------------------
test('mapInventorySyncStatus reads totalPairs from analytics.cron.last_walk', () => {
  const r = mapInventorySyncStatus({
    window_days: 15,
    total: 100,
    cron: {
      enabled: true,
      interval_seconds: 900,
      last_run_at: '2026-07-05T12:00:00Z',
      last_walk: { running: false, completed_at: '2026-07-05T12:00:00Z', total_pairs: 12218, pushed: 42 },
    },
  });
  assert.equal(r.totalPairs, 12218);
  // dryRunWouldPush is rebuilt downstream (NAV avail vs feed), not from analytics.
  assert.equal(r.dryRunWouldPush, null);
  // dryRunAt now carries the pair universe's as-of: the last walk's completion.
  assert.equal(r.dryRunAt, '2026-07-05T12:00:00.000Z');
});

test('mapInventorySyncStatus falls back to cron.last_run_at when the walk has no completed_at', () => {
  const r = mapInventorySyncStatus({
    total: 100,
    cron: { last_run_at: '2026-07-05T11:30:00Z', last_walk: { running: true, total_pairs: 12218 } },
  });
  assert.equal(r.dryRunAt, '2026-07-05T11:30:00.000Z');
  assert.equal(r.totalPairs, 12218);
});

test('mapInventorySyncStatus still honours an explicit dry-run body and yields typed nulls when absent', () => {
  const r = mapInventorySyncStatus({ dryRunWouldPush: 7245, dryRunAt: '2026-07-05T12:00:00Z', totalPairs: 12218 });
  assert.equal(r.dryRunWouldPush, 7245);
  assert.equal(r.dryRunAt, '2026-07-05T12:00:00.000Z');
  assert.equal(r.totalPairs, 12218);
  assert.deepEqual(mapInventorySyncStatus({}), { dryRunWouldPush: null, dryRunAt: null, totalPairs: null });
});

// --- GET /api/nav/inventory-sync/recent (dry-run reconstruction feed) --------
test('mapInventorySyncFeed keeps the pair key + last-set quantity and flags reversal/error rows', () => {
  const rows = mapInventorySyncFeed({
    days: 15,
    total: 3,
    rows: [
      { id: 3, sku: 'GND-1', location_code: 'HF1FTZ', shopify_set_quantity: 12, synced_at: '2026-07-05T11:00:00Z', error: null, reversed_at: null },
      { id: 2, sku: 'GND-2', location_code: 'TAC', shopify_set_quantity: 4, synced_at: '2026-07-05T10:00:00Z', error: 'idempotency', reversed_at: null },
      { id: 1, sku: 'GND-3', location_code: 'TAC', shopify_set_quantity: 7, synced_at: '2026-07-05T09:00:00Z', error: null, reversed_at: '2026-07-05T09:30:00Z' },
    ],
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { sku: 'GND-1', location: 'HF1FTZ', shopifySetQuantity: 12, syncedAt: '2026-07-05T11:00:00.000Z', reversed: false, hasError: false });
  assert.equal(rows[1].hasError, true);
  assert.equal(rows[2].reversed, true);
  assert.deepEqual(mapInventorySyncFeed({ rows: [] }), []);
});

// --- Allocator ATP-fallback + error classifiers -----------------------------
test('countAtpFallbacks counts single_location + out_of_stock and excludes stock_asymmetry', () => {
  assert.equal(
    countAtpFallbacks([
      { reason: 'single_location' },
      { reason: 'out_of_stock' },
      { reason: 'stock_asymmetry' }, // Rule 1 guardrail, not a fallback
      { reason: 'rolled' },
      { reason: 'order_level_pref' },
    ]),
    2,
  );
  assert.equal(countAtpFallbacks([]), 0);
});

test('isAllocationErrorRow attributes only orders-webhook / allocator rows', () => {
  assert.equal(isAllocationErrorRow({ kind: 'event', summary: 'webhook_orders_updated: boom' }), true);
  assert.equal(isAllocationErrorRow({ kind: 'webhook', summary: 'Webhook: orders/create · failed' }), true);
  assert.equal(isAllocationErrorRow({ route_hint: 'warehouse-split', kind: 'event', summary: 'x' }), true);
  assert.equal(isAllocationErrorRow({ kind: 'inventory_push', summary: 'Inventory: X → 5' }), false);
  assert.equal(isAllocationErrorRow({ kind: 'event', summary: 'oauth_callback: ok' }), false);
});

test('deriveAllocatorFailedCount returns null only when the errors body is absent', () => {
  assert.equal(deriveAllocatorFailedCount(undefined), null);
  assert.equal(deriveAllocatorFailedCount({ rows: [] }), 0);
  assert.equal(
    deriveAllocatorFailedCount({ rows: [{ kind: 'event', summary: 'webhook_orders_updated: fail' }] }),
    1,
  );
});

// --- GET /api/warehouse/rollout/audit + /api/oos-held -----------------------
test('mapAllocationDecision maps a warehouse_allocation_log row (reason -> rule, warehouse_assigned -> location)', () => {
  const d = mapAllocationDecision({
    decided_at: '2026-07-05T10:00:00Z',
    order_id: 319090,
    sku: 'GND-1001',
    warehouse_assigned: 'NEW',
    nav_location_code: 'HF1FTZ',
    reason: 'stock_asymmetry',
  });
  assert.equal(d.order_ref, '319090');
  assert.equal(d.sku, 'GND-1001');
  assert.equal(d.rule, 'stock_asymmetry');
  assert.equal(d.location, 'NEW');
  assert.equal(d.outcome, 'allocated');
  assert.equal(d.decided_at, '2026-07-05T10:00:00.000Z');
});

test('mapAllocationDecision derives an unallocatable outcome from an out_of_stock reason', () => {
  assert.equal(mapAllocationDecision({ reason: 'out_of_stock' }).outcome, 'unallocatable');
  // An explicit outcome still wins; unknown outcome/channel coerce safely.
  const d = mapAllocationDecision({ outcome: 'weird', channel: 'xx' });
  assert.equal(d.outcome, 'allocated');
  assert.equal(d.channel, null);
});

test('mapAllocatorStatus composes split sample + window from the audit page and OOS-held backlog', () => {
  const audit = {
    total: 247,
    rows: [
      // order 1 split across two warehouses (OLD + NEW) -> counts as 1 split
      { order_id: 1, line_item_id: 10, warehouse_assigned: 'OLD', reason: 'rolled', decided_at: '2026-07-05T10:05:00Z' },
      { order_id: 1, line_item_id: 11, warehouse_assigned: 'NEW', reason: 'rolled', decided_at: '2026-07-05T10:05:00Z' },
      // order 2 single warehouse -> not a split
      { order_id: 2, line_item_id: 20, warehouse_assigned: 'NEW', reason: 'order_level_pref', decided_at: '2026-07-05T10:00:00Z' },
    ],
  };
  const oosHeld = [
    { order_id: 900, status: 'needs_operator', class: 'transient', first_seen_at: '2026-07-05T09:00:00Z' },
    { order_id: 901, status: 'pending', class: 'backorder', first_seen_at: '2026-07-05T08:00:00Z' },
  ];
  const now = Date.parse('2026-07-05T10:05:00Z');
  const r = mapAllocatorStatus(audit, oosHeld, undefined, now);
  assert.equal(r.lastDecisionAt, '2026-07-05T10:05:00.000Z');
  assert.equal(r.decisionsWindow, 3);
  assert.equal(r.splitCount, 1);
  assert.equal(r.windowSeconds, 300); // 10:05:00 - 10:00:00
  // Unit 4: unallocatable is WINDOW-scoped now (audit rows with an out-of-stock
  // outcome), NOT the OOS-held backlog. These audit reasons are rolled /
  // order_level_pref, so zero in-window unallocatable.
  assert.equal(r.unallocatableCount, 0);
  // The standing OOS-held backlog is surfaced separately and NEVER in the rate.
  assert.equal(r.oosHeldCount, 2);
  assert.equal(r.oosHeldOldestAgeS, 2 * 3600 + 5 * 60); // oldest first_seen 08:00 vs now 10:05
  assert.equal(r.recentDecisions.length, 3);
  // Liveness proxy = recency of the newest decision (no heartbeat endpoint).
  assert.equal(r.serviceHeartbeatAt, '2026-07-05T10:05:00.000Z');
  // No rows carry an ATP-fallback reason (rolled / order_level_pref) -> real 0.
  assert.equal(r.atpFallbackCount, 0);
  // No errors body was passed -> failedCount is 'unknown' (null), not a false 0.
  assert.equal(r.failedCount, null);
});

test('mapAllocatorStatus counts ATP-fallback reasons (single_location + out_of_stock) from the audit page', () => {
  const audit = {
    rows: [
      { order_id: 1, line_item_id: 10, warehouse_assigned: 'NEW', reason: 'single_location', decided_at: '2026-07-05T10:05:00Z' },
      { order_id: 2, line_item_id: 20, warehouse_assigned: 'OLD', reason: 'out_of_stock', decided_at: '2026-07-05T10:04:00Z' },
      { order_id: 3, line_item_id: 30, warehouse_assigned: 'NEW', reason: 'stock_asymmetry', decided_at: '2026-07-05T10:03:00Z' }, // guardrail, NOT a fallback
      { order_id: 4, line_item_id: 40, warehouse_assigned: 'OLD', reason: 'order_level_pref', decided_at: '2026-07-05T10:02:00Z' },
    ],
  };
  assert.equal(mapAllocatorStatus(audit, []).atpFallbackCount, 2); // single_location + out_of_stock only
});

test('mapAllocatorStatus derives failedCount from allocation-attributable /api/errors rows', () => {
  const audit = { rows: [{ order_id: 1, line_item_id: 10, warehouse_assigned: 'NEW', reason: 'rolled', decided_at: '2026-07-05T10:05:00Z' }] };
  const errors = {
    days: 15,
    total: 4,
    rows: [
      // allocation-attributable: orders/updated webhook is the allocator's entry point
      { kind: 'event', summary: 'webhook_orders_updated: staging write failed', status: 'error', route_hint: null },
      { kind: 'webhook', summary: 'Webhook: orders/updated · failed', status: 'error', route_hint: 'webhooks' },
      // NOT allocation-related
      { kind: 'inventory_push', summary: 'Inventory: X @ HF1FTZ → 5', status: 'error', route_hint: 'inventory-sync' },
      { kind: 'price_push', summary: 'Price: Y → 9.99', status: 'error', route_hint: 'price-sync' },
    ],
  };
  assert.equal(mapAllocatorStatus(audit, [], errors).failedCount, 2);
  // A parsed-but-empty errors feed is a real zero (green), not unknown.
  assert.equal(mapAllocatorStatus(audit, [], { rows: [] }).failedCount, 0);
});

test('mapAllocatorStatus returns honest nulls when the audit page is empty and oos-held not an array', () => {
  const r = mapAllocatorStatus({ rows: [] }, {});
  assert.deepEqual(r.recentDecisions, []);
  assert.equal(r.lastDecisionAt, null);
  assert.equal(r.serviceHeartbeatAt, null); // no decisions -> no liveness proxy
  assert.equal(r.decisionsWindow, null);
  assert.equal(r.splitCount, null);
  assert.equal(r.atpFallbackCount, null); // empty audit page -> unknown, not a false zero
  assert.equal(r.unallocatableCount, null); // empty audit page -> unknown, not a false zero
  assert.equal(r.oosHeldCount, null); // non-array oos body -> unknown, not a false zero
  assert.equal(r.oosHeldOldestAgeS, null);
});

// --- GET /api/nav/job-queue/health ------------------------------------------
test('mapJobQueueHealthStatus adopts `level` as the verdict and reads the real fields', () => {
  const r = mapJobQueueHealthStatus({
    level: 'Warn',
    summary: 'auto-release silent 18m',
    last_auto_release: '2026-07-05T09:00:00Z',
    pending_staging: 7,
    stuck_jobs: [
      { id: 'a', minutes_stuck: 45 },
      { id: 'b', minutes_stuck: 12 },
    ],
    queried_at: '2026-07-05T09:05:00Z',
  });
  assert.equal(r.verdict, 'Warn');
  assert.equal(r.autoReleaseFiredAt, '2026-07-05T09:00:00.000Z');
  assert.equal(r.longestRunningJobS, 45 * 60); // max minutes_stuck -> seconds
  assert.equal(r.stuckJobCount, 2); // stuck_jobs.length
  assert.equal(r.checkedAt, '2026-07-05T09:05:00.000Z');
});

test('mapJobQueueHealthStatus reports zero stuck jobs (green) from an empty stuck_jobs array', () => {
  const r = mapJobQueueHealthStatus({ level: 'Ok', stuck_jobs: [], queried_at: '2026-07-05T09:05:00Z' });
  assert.equal(r.verdict, 'Ok');
  assert.equal(r.stuckJobCount, 0);
  assert.equal(r.longestRunningJobS, null);
});

// --- GET /api/nav/price-sync/recent + /settings -----------------------------
test('mapPriceSyncStatus composes last-received (recent) + last-run (settings)', () => {
  const recent = {
    days: 15,
    rows: [
      { id: 2, sku: 'X', synced_at: '2026-07-05T08:00:00Z' },
      { id: 1, sku: 'Y', synced_at: '2026-07-05T07:00:00Z' },
    ],
  };
  const settings = { enabled: true, interval_seconds: 900, last_run_at: '2026-07-05T08:30:00Z' };
  const r = mapPriceSyncStatus(recent, settings);
  assert.equal(r.lastReceivedAt, '2026-07-05T08:00:00.000Z'); // newest row
  assert.equal(r.lastRunAt, '2026-07-05T08:30:00.000Z');
  assert.equal(r.enabled, true); // ADR-0008: the settings.enabled flag
  // A disabled feature reports enabled:false; an absent flag stays unknown (null).
  assert.equal(mapPriceSyncStatus({ rows: [] }, { enabled: false }).enabled, false);
  assert.deepEqual(mapPriceSyncStatus({ rows: [] }, {}), {
    lastReceivedAt: null,
    lastRunAt: null,
    enabled: null,
  });
});

// --- GET /api/shopify/webhooks/subscriptions + /events ----------------------
test('mapWebhookTopic marks a topic subscribed unless deactivated_at is set', () => {
  assert.equal(mapWebhookTopic({ topic: 'orders/create' }).subscribed, true);
  assert.equal(mapWebhookTopic({ topic: 'orders/create', deactivated_at: null }).subscribed, true);
  assert.equal(mapWebhookTopic({ topic: 'orders/create', deactivated_at: '2026-07-01T00:00:00Z' }).subscribed, false);
});

test('mapShopifyWebhookStatus joins subscriptions to per-topic last-received events', () => {
  const subscriptions = [
    { topic: 'orders/create', deactivated_at: null },
    { topic: 'fulfillments/create', deactivated_at: '2026-07-01T00:00:00Z' }, // removed subscription
  ];
  const events = {
    total: 3,
    events: [
      { topic: 'orders/create', received_at: '2026-07-05T07:00:00Z' },
      { topic: 'orders/create', received_at: '2026-07-05T07:30:00Z' }, // newer
      { topic: 'fulfillments/create', received_at: '2026-07-04T06:00:00Z' },
    ],
  };
  const r = mapShopifyWebhookStatus(subscriptions, events);
  const create = r.topics.find((t) => t.topic === 'orders/create');
  const fulfil = r.topics.find((t) => t.topic === 'fulfillments/create');
  assert.equal(create?.subscribed, true);
  assert.equal(create?.lastReceivedAt, '2026-07-05T07:30:00.000Z');
  assert.equal(fulfil?.subscribed, false); // deactivated
  assert.equal(fulfil?.lastReceivedAt, '2026-07-04T06:00:00.000Z');
});

test('mapShopifyWebhookStatus surfaces a topic with traffic but no subscription row as unsubscribed', () => {
  const r = mapShopifyWebhookStatus([], { events: [{ topic: 'orders/updated', received_at: '2026-07-05T07:00:00Z' }] });
  assert.equal(r.topics.length, 1);
  assert.equal(r.topics[0].topic, 'orders/updated');
  assert.equal(r.topics[0].subscribed, false);
  assert.deepEqual(mapShopifyWebhookStatus([], { events: [] }).topics, []);
});

// --- GET /api/nav/back-sync/feed --------------------------------------------
test('mapBackSyncStatus derives watermark + 24h counters from the feed rows', () => {
  const now = Date.parse('2026-07-05T12:00:00Z');
  const feed = {
    mode: 'live',
    total: 3,
    rows: [
      // fulfilled 1h ago -> counts, and is the newest fulfilled -> watermark
      { nav_shipment_no: 'SH-3', recorded_at: '2026-07-05T11:00:00Z', shopify_fulfillment_id: 903, error: null },
      // errored 2h ago -> error count
      { nav_shipment_no: 'SH-2', recorded_at: '2026-07-05T10:00:00Z', shopify_fulfillment_id: null, error: 'timeout' },
      // fulfilled 40h ago -> outside 24h window, not counted, but eligible watermark (older)
      { nav_shipment_no: 'SH-1', recorded_at: '2026-07-03T20:00:00Z', shopify_fulfillment_id: 901, error: null },
    ],
  };
  const r = mapBackSyncStatus(feed, now);
  assert.equal(r.lastBackSyncAt, '2026-07-05T11:00:00.000Z');
  assert.equal(r.fulfillmentsLast24h, 1);
  assert.equal(r.errorsLast24h, 1);
  // Liveness proxy: newest recorded_at of ANY row (the errored SH-2 has no
  // fulfillment id but is still newer than the fulfilled SH-3? no — SH-3 is
  // newest overall, so the watcher heartbeat is SH-3's time).
  assert.equal(r.watcherHeartbeatAt, '2026-07-05T11:00:00.000Z');
});

test('mapBackSyncStatus watcher heartbeat tracks the newest row even when it is an errored (unfulfilled) row', () => {
  const now = Date.parse('2026-07-05T12:00:00Z');
  const feed = {
    rows: [
      // newest row is an ERROR row with no fulfillment id -> still proves liveness
      { nav_shipment_no: 'SH-9', recorded_at: '2026-07-05T11:45:00Z', shopify_fulfillment_id: null, error: 'timeout' },
      { nav_shipment_no: 'SH-8', recorded_at: '2026-07-05T11:00:00Z', shopify_fulfillment_id: 908, error: null },
    ],
  };
  const r = mapBackSyncStatus(feed, now);
  assert.equal(r.watcherHeartbeatAt, '2026-07-05T11:45:00.000Z'); // newest of ANY row
  assert.equal(r.lastBackSyncAt, '2026-07-05T11:00:00.000Z'); // watermark: newest WITH fulfillment id
});

// --- GET /api/back-sync/missed-shipments ------------------------------------
test('mapMissedShipments maps the real handler fields via the {missed:[...]} envelope', () => {
  const rows = mapMissedShipments({
    total_missed: 1,
    missed: [
      {
        nav_shipment_no: 'SH-42',
        sales_order: 'SP-319090',
        posting_date: '2026-07-05T05:00:00Z',
        tracking_no: '1Z',
        shipping_agent: 'UPS',
        location_code: 'HF1FTZ',
        status: 'missing',
        last_error: 'no shopify_fulfillment_id',
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].nav_shipment_no, 'SH-42');
  assert.equal(rows[0].order_ref, 'SP-319090');
  assert.equal(rows[0].carrier, 'UPS');
  assert.equal(rows[0].tracking, '1Z');
  assert.equal(rows[0].posted_at, '2026-07-05T05:00:00.000Z');
  assert.equal(rows[0].reason, 'no shopify_fulfillment_id');
  assert.equal(rows[0].web_id, null); // not exposed by this endpoint
  assert.equal(rows[0].age_s, null);
  assert.deepEqual(mapMissedShipments({ missed: [] }), []);
});

// --- Factory: live-vs-stub selection ---------------------------------------
// The factory selects on config.middleware.baseUrl (read live). Drive it by
// toggling that field and restoring it afterwards.
function withBaseUrl<T>(baseUrl: string, fn: () => T): T {
  const prev = config.middleware.baseUrl;
  config.middleware.baseUrl = baseUrl;
  try {
    return fn();
  } finally {
    config.middleware.baseUrl = prev;
  }
}

test('createMiddlewareClient returns the STUB when MIDDLEWARE_BASE_URL is unset', () => {
  const client = withBaseUrl('', () => createMiddlewareClient());
  assert.equal(client.constructor.name, 'MiddlewareClientStub');
});

test('createMiddlewareClient returns the LIVE client when MIDDLEWARE_BASE_URL is set', () => {
  const client = withBaseUrl('https://middleware.grundens.com', () => createMiddlewareClient());
  assert.equal(client.constructor.name, 'MiddlewareClientLive');
});

// --- Stub still answers the whole interface (fallback safety) ---------------
test('the stub returns typed empty shapes for every method, and null missed detail', async () => {
  const stub = new MiddlewareClientStub();
  assert.deepEqual(await stub.getInventorySyncStatus(), {
    dryRunWouldPush: null,
    dryRunAt: null,
    totalPairs: null,
  });
  assert.equal(await stub.getMissedShipmentDetail(), null);
  assert.deepEqual(await stub.getShopifyWebhookStatus(), { topics: [] });
  assert.deepEqual(await stub.getErrors(), []);
  assert.deepEqual(await stub.getInventorySyncFeed(), []);
});

// --- Path table sanity (the real GET routes this consumer calls) ------------
test('MIDDLEWARE_PATHS lists the reconciled real middleware GET routes', () => {
  // Issue #36 — corrected direct paths.
  assert.equal(MIDDLEWARE_PATHS.activity, '/api/activity/recent');
  assert.equal(MIDDLEWARE_PATHS.errors, '/api/errors');
  assert.equal(MIDDLEWARE_PATHS.pendingFulfillment, '/api/middleware/pending-fulfillment-requests');
  assert.equal(MIDDLEWARE_PATHS.jobQueueHealth, '/api/nav/job-queue/health');
  assert.equal(MIDDLEWARE_PATHS.missedShipments, '/api/back-sync/missed-shipments');
  assert.equal(MIDDLEWARE_PATHS.stuckStaging, '/api/nav/stuck-staging');
  // Issue #37 — compose sources.
  assert.equal(MIDDLEWARE_PATHS.backSyncFeed, '/api/nav/back-sync/feed');
  assert.equal(MIDDLEWARE_PATHS.inventorySyncAnalytics, '/api/nav/inventory-sync/analytics');
  assert.equal(MIDDLEWARE_PATHS.inventorySyncRecent, '/api/nav/inventory-sync/recent');
  assert.equal(MIDDLEWARE_PATHS.priceSyncRecent, '/api/nav/price-sync/recent');
  assert.equal(MIDDLEWARE_PATHS.webhookSubscriptions, '/api/shopify/webhooks/subscriptions');
  assert.equal(MIDDLEWARE_PATHS.webhookEvents, '/api/shopify/webhooks/events');
  assert.equal(MIDDLEWARE_PATHS.allocatorAudit, '/api/warehouse/rollout/audit');
  assert.equal(MIDDLEWARE_PATHS.oosHeld, '/api/oos-held');
});
