// Pure-surface tests for the read-only NAV client (no live NAV / az login).
//
// Covers the two testable-without-a-connection parts (design.md QA seat):
//   1. the query builders  -> every table is GRUS$-prefixed and the CU 50007
//      watermark predicate is correct;
//   2. the recordset row -> typed shape mappers (fed fake rows), including the
//      WebOrder-derived channel and the WebOrder value;
//   plus the read-only guard and the Entra auth-mode selection.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NAV_IABC_OBJECT_ID,
  NAV_JOB_STATUS_SUCCESS,
  assertReadOnly,
  buildAuthentication,
  buildQueries,
  channelFromWebOrder,
  classifyForwardSyncTag,
  mapForwardSyncCandidate,
  mapInventoryWalk,
  mapOrderLifecycleRow,
  mapShipmentHeader,
  mapWatermarkState,
  navTable,
  parseSpOrderNumber,
  toIso,
} from './navClient.js';
import type { config } from '../config.js';

// --- Query builders: GRUS$ prefixing + the CU 50007 watermark --------------
test('navTable brackets and company-prefixes the table name', () => {
  assert.equal(navTable('GRUS', 'Sales Header'), '[GRUS$Sales Header]');
  assert.equal(navTable('GRUS', 'Job Queue Log Entry'), '[GRUS$Job Queue Log Entry]');
});

test('every built query prefixes EVERY table with the company code (GRUS$)', () => {
  const q = buildQueries('GRUS');
  const all = Object.values(q).join('\n');
  // Each of the four NAV tables must appear bracketed and GRUS$-prefixed.
  for (const tbl of [
    '[GRUS$Job Queue Log Entry]',
    '[GRUS$Sales Header]',
    '[GRUS$Sales Header Staging]',
    '[GRUS$Sales Shipment Header]',
  ]) {
    assert.ok(all.includes(tbl), `expected ${tbl} in built queries`);
  }
  // The exact stub bug: an UNprefixed NAV table name must never leak. Each of the
  // four tables may appear only in its [GRUS$...] form.
  for (const bare of [
    '[Sales Header]',
    '[Sales Header Staging]',
    '[Sales Shipment Header]',
    '[Job Queue Log Entry]',
  ]) {
    assert.ok(!all.includes(bare), `unprefixed table ${bare} leaked into a query`);
  }
});

test('a non-default company code re-prefixes every table', () => {
  const q = buildQueries('CHILE');
  assert.ok(q.orderLifecycle.includes('[CHILE$Sales Header]'));
  assert.ok(!q.orderLifecycle.includes('[GRUS$'));
});

test('IABC watermark query targets CU 50007 completions (Object 50007, Status 0 = Success)', () => {
  const q = buildQueries('GRUS');
  assert.equal(NAV_IABC_OBJECT_ID, 50007);
  // NAV Job Queue Log Entry Status: 0 = Success, 1 = In Process, 2 = Error.
  assert.equal(NAV_JOB_STATUS_SUCCESS, 0);
  assert.match(q.iabcWatermark, /\[GRUS\$Job Queue Log Entry\]/);
  assert.match(q.iabcWatermark, /\[Object ID to Run\] = @iabcObjectId/);
  assert.match(q.iabcWatermark, /\[Status\] = @successStatus/);
  assert.match(q.iabcWatermark, /MAX|TOP 1[\s\S]*ORDER BY \[Entry No_\] DESC/);
});

test('order lifecycle query selects WebId AND WebOrder from the Sales Header', () => {
  const q = buildQueries('GRUS');
  assert.match(q.orderLifecycle, /h\.\[WebId\] AS webId/);
  assert.match(q.orderLifecycle, /h\.\[WebOrder\] AS webOrder/);
  // Staging joins on its own key, [Nav Order No], not [No_] (which it lacks).
  assert.match(q.orderLifecycle, /LEFT JOIN \[GRUS\$Sales Header Staging\] st ON st\.\[Nav Order No\] = h\.\[No_\]/);
  // Shipment posting date is a MAX scalar subquery (not a fan-out join), so an
  // order with multiple shipments stays one row.
  assert.match(q.orderLifecycle, /SELECT MAX\(sh\.\[Posting Date\]\) FROM \[GRUS\$Sales Shipment Header\] sh WHERE sh\.\[Order No_\] = h\.\[No_\]/);
  // Bounded read.
  assert.match(q.orderLifecycle, /SELECT TOP \(@limit\)/);
});

test('toIso nulls the NAV 1753 sentinel date (avoids the 273-year lag overflow)', () => {
  assert.equal(toIso(new Date('1753-01-01T00:00:00Z')), null);
  assert.equal(toIso(new Date('0001-01-01T00:00:00Z')), null);
  assert.equal(toIso(null), null);
  const real = '2026-07-06T18:00:00.000Z';
  assert.equal(toIso(new Date(real)), real);
});

// --- Read-only enforcement -------------------------------------------------
test('assertReadOnly allows SELECT and rejects any write statement', () => {
  const q = buildQueries('GRUS');
  for (const sql of Object.values(q)) {
    assert.doesNotThrow(() => assertReadOnly(sql));
  }
  for (const bad of [
    'UPDATE [GRUS$Sales Header] SET [WebId] = 1',
    'DELETE FROM [GRUS$Sales Header]',
    'INSERT INTO [GRUS$Sales Header] VALUES (1)',
    'EXEC sp_who',
    'DROP TABLE x',
    'MERGE INTO x',
    'TRUNCATE TABLE x',
  ]) {
    assert.throws(() => assertReadOnly(bad), /read-only/);
  }
});

// --- Mappers: fake rows -> typed shapes ------------------------------------
test('toIso normalises Date, string, and null', () => {
  const d = new Date('2026-07-05T12:00:00.000Z');
  assert.equal(toIso(d), '2026-07-05T12:00:00.000Z');
  assert.equal(toIso('2026-07-05T12:00:00Z'), '2026-07-05T12:00:00.000Z');
  assert.equal(toIso(null), null);
  assert.equal(toIso(undefined), null);
});

test('mapWatermarkState maps entry no + end time; watermarkEntryNo stays NAV-null', () => {
  const state = mapWatermarkState(
    { entryNo: 4210, startAt: new Date('2026-07-05T09:00:00Z'), endAt: new Date('2026-07-05T09:05:00Z') },
    { entryNo: 4212, startAt: new Date('2026-07-05T11:00:00Z'), endAt: null, status: 1 },
  );
  assert.equal(state.navNewestIabcEntryNo, 4210);
  assert.equal(state.lastWalkAt, '2026-07-05T09:05:00.000Z');
  assert.equal(state.watcherHeartbeatAt, '2026-07-05T11:00:00.000Z');
  // watermark (middleware-owned) is not read from NAV.
  assert.equal(state.watermarkEntryNo, null);
});

test('mapWatermarkState is null-safe on missing rows', () => {
  const state = mapWatermarkState(undefined, undefined);
  assert.deepEqual(state, {
    navNewestIabcEntryNo: null,
    watermarkEntryNo: null,
    lastWalkAt: null,
    watcherHeartbeatAt: null,
  });
});

test('mapInventoryWalk carries the completion time; counts default to 0', () => {
  const w = mapInventoryWalk({ entryNo: 1, endAt: new Date('2026-07-05T09:05:00Z'), status: 2 });
  assert.equal(w.walk_at, '2026-07-05T09:05:00.000Z');
  assert.equal(w.processed, 0);
  assert.equal(w.pushed, 0);
  assert.equal(w.skipped, 0);
  assert.equal(w.untracked_filtered, 0);
});

test('channelFromWebOrder: 1 => dtc, 0 / null => wholesale', () => {
  assert.equal(channelFromWebOrder(1), 'dtc');
  assert.equal(channelFromWebOrder(0), 'wholesale');
  assert.equal(channelFromWebOrder(null), 'wholesale');
});

test('mapOrderLifecycleRow: WebOrder=1 => dtc row carrying webOrder and webId', () => {
  const row = mapOrderLifecycleRow({
    navOrderNo: 'SO-1001',
    customerRef: 'WEB-CUST',
    orderDate: new Date('2026-07-05T08:00:00Z'),
    webId: 'gid://shopify/Order/5551024',
    webOrder: 1,
    navStagingStatus: 0,
    navShipmentAt: new Date('2026-07-05T10:00:00Z'),
  });
  assert.equal(row.channel, 'dtc');
  assert.equal(row.webOrder, 1);
  assert.equal(row.webId, 'gid://shopify/Order/5551024');
  assert.equal(row.navOrderNo, 'SO-1001');
  assert.equal(row.shopifyOrderAt, '2026-07-05T08:00:00.000Z');
  assert.equal(row.navShipmentAt, '2026-07-05T10:00:00.000Z');
  assert.equal(row.navStagingStatus, 0);
  assert.equal(row.missedBackSync, false);
});

test('mapOrderLifecycleRow: WebOrder=1 with empty WebId => dtc orphan candidate', () => {
  const row = mapOrderLifecycleRow({
    navOrderNo: 'SO-1002',
    customerRef: 'WEB-CUST',
    orderDate: new Date('2026-07-05T08:00:00Z'),
    webId: '',
    webOrder: 1,
    navStagingStatus: 1,
    navShipmentAt: null,
  });
  assert.equal(row.channel, 'dtc');
  assert.equal(row.webOrder, 1);
  assert.equal(row.webId, '');
  assert.equal(row.navStagingStatus, 1);
});

test('mapOrderLifecycleRow: WebOrder=0 => wholesale, no shopifyOrderAt', () => {
  const row = mapOrderLifecycleRow({
    navOrderNo: 'WS-2001',
    customerRef: 'CUST-4400',
    orderDate: new Date('2026-07-05T08:00:00Z'),
    webId: '',
    webOrder: 0,
    navStagingStatus: null,
    navShipmentAt: new Date('2026-07-05T10:00:00Z'),
  });
  assert.equal(row.channel, 'wholesale');
  assert.equal(row.webOrder, 0);
  assert.equal(row.shopifyOrderAt, null); // wholesale has no Shopify leg
  assert.equal(row.navShipmentAt, '2026-07-05T10:00:00.000Z');
});

test('mapShipmentHeader maps the shipment header columns', () => {
  const s = mapShipmentHeader({
    navShipmentNo: 'PS-9001',
    webId: 'w-1',
    orderRef: 'SO-1001',
    carrier: 'FEDEX',
    tracking: '1Z-ABC',
    postedAt: new Date('2026-07-05T10:00:00Z'),
  });
  assert.deepEqual(s, {
    navShipmentNo: 'PS-9001',
    webId: 'w-1',
    orderRef: 'SO-1001',
    carrier: 'FEDEX',
    tracking: '1Z-ABC',
    postedAt: '2026-07-05T10:00:00.000Z',
  });
});

// --- Entra auth mode selection ---------------------------------------------
type NavCfg = typeof config.nav;
function navCfg(overrides: Partial<NavCfg>): NavCfg {
  return {
    host: 'sql-grus-prd-01.database.windows.net',
    port: 1433,
    database: 'sqldb-nav18-grus-prd-01',
    encrypt: true,
    authMode: 'aad-default',
    aadTenantId: '',
    aadClientId: '',
    aadClientSecret: '',
    company: 'GRUS',
    orderIngestLimit: 1000,
    ...overrides,
  };
}

test('NAV_AUTH_MODE=aad-default selects azure-active-directory-default', () => {
  const auth = buildAuthentication(navCfg({ authMode: 'aad-default' }));
  assert.equal(auth.type, 'azure-active-directory-default');
  assert.equal(auth.options, undefined);
});

test('NAV_AUTH_MODE=aad-service-principal passes tenant/client/secret', () => {
  const auth = buildAuthentication(
    navCfg({
      authMode: 'aad-service-principal',
      aadTenantId: 'tenant-1',
      aadClientId: 'client-1',
      aadClientSecret: 'secret-1',
    }),
  );
  assert.equal(auth.type, 'azure-active-directory-service-principal-secret');
  assert.deepEqual(auth.options, {
    tenantId: 'tenant-1',
    clientId: 'client-1',
    clientSecret: 'secret-1',
  });
});

test('NAV_AUTH_MODE=aad-msi selects the managed-identity type', () => {
  const auth = buildAuthentication(navCfg({ authMode: 'aad-msi' }));
  assert.equal(auth.type, 'azure-active-directory-msi-app-service');
});

// --- forward_sync helpers (Unit 11, ADR-0006) ------------------------------
test('classifyForwardSyncTag maps the ADR-0006 candidate tags', () => {
  // The exported tag => shopify_exported.
  assert.equal(
    classifyForwardSyncTag('1-Status:Shopify-Exported!'),
    'shopify_exported',
  );
  // The middleware-status tag => middleware_status.
  assert.equal(classifyForwardSyncTag('1-Middleware Status!'), 'middleware_status');
  // The legacy imported tag also => middleware_status.
  assert.equal(
    classifyForwardSyncTag('1-Status:Middleware-Imported!'),
    'middleware_status',
  );
  // Exported wins when both are present (the earlier, more specific stall signal).
  assert.equal(
    classifyForwardSyncTag('1-Middleware Status!, 1-Status:Shopify-Exported!'),
    'shopify_exported',
  );
  // Terminal NAV-Created only / empty / null => unknown (never a candidate).
  assert.equal(classifyForwardSyncTag('1-Status:NAV-Created!'), 'unknown');
  assert.equal(classifyForwardSyncTag(''), 'unknown');
  assert.equal(classifyForwardSyncTag(null), 'unknown');
});

test('parseSpOrderNumber extracts the <n> correlation key', () => {
  assert.equal(parseSpOrderNumber('SP-319319-1'), '319319'); // legged (open order)
  assert.equal(parseSpOrderNumber('SP-99999'), '99999');     // bare (posted invoice)
  assert.equal(parseSpOrderNumber('sp-42-2'), '42');         // case-insensitive prefix
  assert.equal(parseSpOrderNumber('X-1'), null);             // non-SP-
  assert.equal(parseSpOrderNumber(''), null);
  assert.equal(parseSpOrderNumber(null), null);
});

test('mapForwardSyncCandidate maps a staging row to the typed shape', () => {
  const cand = mapForwardSyncCandidate({
    shopifyOrderName: 'SP-319121',
    createdAt: new Date('2026-07-01T14:00:00Z'),
    orderTags: '1-Status:Shopify-Exported!',
    status: 1,
    navOrderNo: '', // empty => not promoted (a real candidate)
    errorMessage: 'Item is blocked',
  });
  assert.deepEqual(cand, {
    shopifyOrderName: 'SP-319121',
    shopifyNumber: '319121',
    createdAt: '2026-07-01T14:00:00.000Z',
    tag: 'shopify_exported',
    navOrderNo: null, // toStr('') => null
    status: 1,
    errorMessage: 'Item is blocked',
  });
});

test('the four forward_sync queries are GRUS$-prefixed and read-only', () => {
  const q = buildQueries('GRUS');
  for (const sql of [
    q.forwardSyncStagingCandidates,
    q.forwardSyncPresentHeaders,
    q.forwardSyncPresentInvoices,
    q.forwardSyncLastSuccess,
  ]) {
    assert.doesNotThrow(() => assertReadOnly(sql));
  }
  // Staging candidates + last-success read GRUS$Sales Header Staging.
  assert.match(q.forwardSyncStagingCandidates, /\[GRUS\$Sales Header Staging\]/);
  assert.match(q.forwardSyncStagingCandidates, /SELECT TOP \(@limit\)/);
  assert.match(q.forwardSyncLastSuccess, /\[GRUS\$Sales Header Staging\]/);
  assert.match(q.forwardSyncLastSuccess, /MAX\(\[CreatedDate\]\)/);
  // Presence checks read the two GRUS$-prefixed headers under SP-%.
  assert.match(q.forwardSyncPresentHeaders, /\[GRUS\$Sales Header\][\s\S]*LIKE 'SP-%'/);
  assert.match(q.forwardSyncPresentInvoices, /\[GRUS\$Sales Invoice Header\][\s\S]*LIKE 'SP-%'/);
  // No unprefixed table name leaks.
  assert.ok(!q.forwardSyncPresentInvoices.includes('[Sales Invoice Header]'));
});
