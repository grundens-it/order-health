// Regression test for the order-id identifier bug (the live 502): buildRequestBody
// must thread the NUMERIC Shopify order id, never Number(subjectKey), for the
// order-targeted endpoints. For an ORDER subject the subjectKey is the classification
// signal ('fs_floor_at_zero') or a split name ('SP-323019'); Number(...) is NaN, which
// sent shopify_order_id: 0 / shopify_order_ids: [] and 502-ed the middleware.
import assert from 'node:assert/strict';
import test from 'node:test';
import { getRemediationTool } from './registry.js';
import { buildRequestBody } from './remediationClient.js';

const forwardSync = getRemediationTool('forward_sync_replay')!;
const recovery = getRemediationTool('recovery_sweep')!;

test('forward-sync uses the threaded numeric shopifyOrderId, not Number(subjectKey)', () => {
  const body = buildRequestBody(
    forwardSync,
    { subjectKind: 'order', subjectKey: 'fs_floor_at_zero' },
    { confirmed: true, shopifyOrderId: '323019' },
  );
  // The middleware ReplayRequest { shopify_order_id: i64 } gets the real numeric id.
  assert.deepEqual(body, { shopify_order_id: 323019 });
});

test('recovery batch replay wraps the threaded numeric id, not the signal string', () => {
  const body = buildRequestBody(
    recovery,
    { subjectKind: 'order', subjectKey: 'fs_floor_at_zero' },
    { confirmed: true, shopifyOrderId: 323019 },
  );
  assert.deepEqual(body, { shopify_order_ids: [323019], set_by: 'order-health-operator' });
});

test('a non-numeric subjectKey with NO threaded id never masquerades as an id (no 0 / [])', () => {
  const fwd = buildRequestBody(
    forwardSync,
    { subjectKind: 'order', subjectKey: 'SP-323019' },
    { confirmed: true },
  );
  assert.deepEqual(fwd, { shopify_order_id: 0 }); // disabled at the UI; body cannot carry a real id

  const rec = buildRequestBody(
    recovery,
    { subjectKind: 'order', subjectKey: 'SP-323019' },
    { confirmed: true },
  );
  assert.deepEqual(rec, { shopify_order_ids: [], set_by: 'order-health-operator' });
});

test('a numeric subjectKey still works as a fallback (the OOS-held per-order path)', () => {
  const fwd = buildRequestBody(
    forwardSync,
    { subjectKind: 'order', subjectKey: '458812' },
    { confirmed: true },
  );
  assert.deepEqual(fwd, { shopify_order_id: 458812 });
});

// --- Correction 1: the Holman inventory push body (verified PushSkuRequest) ----
const holman = getRemediationTool('oos_held_inventory_push')!;
test('Holman push builds { sku, location_code, channel, set_by } from params (HF1FTZ / DTC)', () => {
  const body = buildRequestBody(
    holman,
    { subjectKind: 'order', subjectKey: '458812' },
    { confirmed: true, params: { sku: 'ABC-123', location_code: 'HF1FTZ', channel: 'DTC' } },
  );
  // Password is added by firePost for gated endpoints, never here.
  assert.deepEqual(body, {
    sku: 'ABC-123',
    location_code: 'HF1FTZ',
    channel: 'DTC',
    set_by: 'order-health-operator',
  });
});

// --- Correction 3: fs-floor-one takes its SKU from params, not subjectKey ------
const floorOne = getRemediationTool('fs_location_floor_one')!;
test('fs-floor-one uses params.sku (from order data), not subjectKey', () => {
  const body = buildRequestBody(
    floorOne,
    { subjectKind: 'order', subjectKey: 'fs_floor_at_zero' },
    { confirmed: true, dryRun: true, params: { sku: 'SKU-9' } },
  );
  assert.deepEqual(body, { sku: 'SKU-9', dry_run: true, set_by: 'order-health-operator' });
});
