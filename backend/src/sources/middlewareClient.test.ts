// Pure-surface tests for the read-only middleware HTTP client (no live fetch).
//
// Covers the parts testable without a live middleware (design.md QA seat):
//   1. the per-endpoint JSON mappers  -> a fake response body maps to the EXACT
//      typed shape the MiddlewareClient interface declares (camelCase AND
//      snake_case wire variants both accepted);
//   2. the read-only GET guard + the URL / header builders (Bearer only when a
//      token is set);
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
  buildUrl,
  mapAllocationDecision,
  mapAllocatorStatus,
  mapBackSyncStatus,
  mapInventorySyncStatus,
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

// --- URL + header builders --------------------------------------------------
test('buildUrl joins base + path without doubling the slash', () => {
  assert.equal(buildUrl('https://middleware.grundens.com', '/api/dashboard/errors'),
    'https://middleware.grundens.com/api/dashboard/errors');
  assert.equal(buildUrl('https://middleware.grundens.com/', '/api/dashboard/errors'),
    'https://middleware.grundens.com/api/dashboard/errors');
});

test('buildHeaders sends Bearer ONLY when a token is set (endpoints are unauthenticated)', () => {
  const none = buildHeaders('');
  assert.equal(none.Accept, 'application/json');
  assert.equal(none.Authorization, undefined);
  const withToken = buildHeaders('ro-token');
  assert.equal(withToken.Authorization, 'Bearer ro-token');
});

// --- Body coercion helpers --------------------------------------------------
test('asRecordArray tolerates bare arrays and {items|rows|data} envelopes', () => {
  assert.deepEqual(asRecordArray([{ a: 1 }]), [{ a: 1 }]);
  assert.deepEqual(asRecordArray({ items: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(asRecordArray({ rows: [{ b: 2 }] }), [{ b: 2 }]);
  assert.deepEqual(asRecordArray(null), []);
  assert.deepEqual(asRecordArray('nope'), []);
});

test('asRecord returns objects and coerces non-objects to {}', () => {
  assert.deepEqual(asRecord({ a: 1 }), { a: 1 });
  assert.deepEqual(asRecord([1, 2]), {});
  assert.deepEqual(asRecord(null), {});
});

// --- GET /api/inventory-sync/status ----------------------------------------
test('mapInventorySyncStatus maps the dry-run divergence (camelCase)', () => {
  const r = mapInventorySyncStatus({
    dryRunWouldPush: 7245,
    dryRunAt: '2026-07-05T12:00:00Z',
    totalPairs: 12218,
  });
  assert.equal(r.dryRunWouldPush, 7245);
  assert.equal(r.dryRunAt, '2026-07-05T12:00:00.000Z');
  assert.equal(r.totalPairs, 12218);
});

test('mapInventorySyncStatus accepts snake_case and yields typed nulls when absent', () => {
  const r = mapInventorySyncStatus({ dry_run_would_push: 10, total_pairs: 100 });
  assert.equal(r.dryRunWouldPush, 10);
  assert.equal(r.totalPairs, 100);
  assert.equal(r.dryRunAt, null);
  assert.deepEqual(mapInventorySyncStatus({}), {
    dryRunWouldPush: null,
    dryRunAt: null,
    totalPairs: null,
  });
});

// --- GET /api/allocator/status ---------------------------------------------
test('mapAllocationDecision maps a warehouse_allocation_log row to the typed shape', () => {
  const d = mapAllocationDecision({
    decided_at: '2026-07-05T10:00:00Z',
    order_ref: 'SP-319090',
    channel: 'dtc',
    sku: 'GND-1001',
    qty: 3,
    rule: 'least-split -> TAC',
    location: 'TAC',
    outcome: 'split',
  });
  assert.equal(d.order_ref, 'SP-319090');
  assert.equal(d.channel, 'dtc');
  assert.equal(d.outcome, 'split');
  assert.equal(d.decided_at, '2026-07-05T10:00:00.000Z');
});

test('mapAllocationDecision coerces an unknown/absent outcome to a safe default and unknown channel to null', () => {
  const d = mapAllocationDecision({ outcome: 'weird', channel: 'xx' });
  assert.equal(d.outcome, 'allocated');
  assert.equal(d.channel, null);
});

test('mapAllocatorStatus maps window counts + recent decisions (snake_case)', () => {
  const r = mapAllocatorStatus({
    last_decision_at: '2026-07-05T10:00:00Z',
    service_heartbeat_at: '2026-07-05T10:01:00Z',
    window_seconds: 300,
    decisions_window: 40,
    split_count: 6,
    unallocatable_count: 1,
    failed_count: 2,
    atp_fallback_count: 3,
    recent_decisions: [{ outcome: 'failed' }, { outcome: 'allocated' }],
  });
  assert.equal(r.decisionsWindow, 40);
  assert.equal(r.splitCount, 6);
  assert.equal(r.unallocatableCount, 1);
  assert.equal(r.recentDecisions.length, 2);
  assert.equal(r.recentDecisions[0].outcome, 'failed');
});

test('mapAllocatorStatus returns an empty decisions array when the field is missing', () => {
  const r = mapAllocatorStatus({});
  assert.deepEqual(r.recentDecisions, []);
  assert.equal(r.lastDecisionAt, null);
});

// --- GET /api/nav/job-queue/health -----------------------------------------
test('mapJobQueueHealthStatus adopts the verdict string unchanged', () => {
  const r = mapJobQueueHealthStatus({
    verdict: 'green',
    autoReleaseFiredAt: '2026-07-05T09:00:00Z',
    longestRunningJobS: 45,
    stuckJobCount: 0,
    checkedAt: '2026-07-05T09:05:00Z',
  });
  assert.equal(r.verdict, 'green');
  assert.equal(r.longestRunningJobS, 45);
  assert.equal(r.stuckJobCount, 0);
  assert.equal(r.checkedAt, '2026-07-05T09:05:00.000Z');
});

// --- GET /api/price-sync/status --------------------------------------------
test('mapPriceSyncStatus maps last-received + last-run', () => {
  const r = mapPriceSyncStatus({ last_received_at: '2026-07-05T08:00:00Z', last_run_at: '2026-07-05T08:30:00Z' });
  assert.equal(r.lastReceivedAt, '2026-07-05T08:00:00.000Z');
  assert.equal(r.lastRunAt, '2026-07-05T08:30:00.000Z');
  assert.deepEqual(mapPriceSyncStatus({}), { lastReceivedAt: null, lastRunAt: null });
});

// --- GET /api/webhooks/shopify/health --------------------------------------
test('mapWebhookTopic defaults subscribed to true when absent, false only when explicit', () => {
  assert.equal(mapWebhookTopic({ topic: 'orders/create' }).subscribed, true);
  assert.equal(mapWebhookTopic({ topic: 'orders/create', subscribed: false }).subscribed, false);
});

test('mapShopifyWebhookStatus accepts a bare array or a {topics:[...]} envelope', () => {
  const fromArray = mapShopifyWebhookStatus([
    { topic: 'orders/create', last_received_at: '2026-07-05T07:00:00Z', subscribed: true },
  ]);
  assert.equal(fromArray.topics.length, 1);
  assert.equal(fromArray.topics[0].topic, 'orders/create');
  assert.equal(fromArray.topics[0].lastReceivedAt, '2026-07-05T07:00:00.000Z');

  const fromEnvelope = mapShopifyWebhookStatus({ topics: [{ topic: 'fulfillments/create', subscribed: false }] });
  assert.equal(fromEnvelope.topics[0].subscribed, false);
  assert.deepEqual(mapShopifyWebhookStatus({}).topics, []);
});

// --- GET /api/back-sync/status ---------------------------------------------
test('mapBackSyncStatus maps watermark + heartbeat + 24h counters', () => {
  const r = mapBackSyncStatus({
    lastBackSyncAt: '2026-07-05T06:00:00Z',
    watcherHeartbeatAt: '2026-07-05T06:05:00Z',
    fulfillmentsLast24h: 120,
    errorsLast24h: 2,
  });
  assert.equal(r.lastBackSyncAt, '2026-07-05T06:00:00.000Z');
  assert.equal(r.fulfillmentsLast24h, 120);
  assert.equal(r.errorsLast24h, 2);
});

// --- GET /api/back-sync/missed-shipments -----------------------------------
test('mapMissedShipments maps rows; an empty array stays an empty array (real zero-missed)', () => {
  const rows = mapMissedShipments([
    {
      order_ref: 'SP-319090',
      web_id: 'W-1',
      nav_shipment_no: 'SH-42',
      carrier: 'UPS',
      tracking: '1Z',
      posted_at: '2026-07-05T05:00:00Z',
      age_s: 3600,
      reason: 'escalated after 6h',
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].nav_shipment_no, 'SH-42');
  assert.equal(rows[0].posted_at, '2026-07-05T05:00:00.000Z');
  assert.deepEqual(mapMissedShipments([]), []);
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
});

// --- Path table sanity (the endpoints this consumer calls, GET-only) --------
test('MIDDLEWARE_PATHS lists exactly the existing dashboard.rs GET routes', () => {
  assert.equal(MIDDLEWARE_PATHS.errors, '/api/dashboard/errors');
  assert.equal(MIDDLEWARE_PATHS.inventorySyncStatus, '/api/inventory-sync/status');
  assert.equal(MIDDLEWARE_PATHS.backSyncStatus, '/api/back-sync/status');
  assert.equal(MIDDLEWARE_PATHS.missedShipments, '/api/back-sync/missed-shipments');
  assert.equal(MIDDLEWARE_PATHS.priceSyncStatus, '/api/price-sync/status');
  assert.equal(MIDDLEWARE_PATHS.jobQueueHealth, '/api/nav/job-queue/health');
  assert.equal(MIDDLEWARE_PATHS.shopifyWebhookHealth, '/api/webhooks/shopify/health');
  assert.equal(MIDDLEWARE_PATHS.allocatorStatus, '/api/allocator/status');
});
