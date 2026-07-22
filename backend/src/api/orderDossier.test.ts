// Tests for the single-order dossier assembler (ADR-0012), rebuilt around the NAV
// composite (open + posted). Pure: seeded inputs in, asserted dossier out. They pin the
// resolution across shipped orders, the per-line status rollup, the overall status, the
// verdict parity with the board, and that PII cannot appear.
import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleDossier, type DossierInputs } from './orderDossier.js';
import { assembleOrderComposite } from '../sources/navClient.js';
import type { NavEdiSendRow, NavHoldRow, NavIabcRow } from '../sources/navClient.js';

const HOLMAN = '2538727140';

function edi940(over: Partial<NavEdiSendRow> = {}): NavEdiSendRow {
  return {
    docNo: 'SP-322263-1', tradePartner: HOLMAN, ediDoc: '940', internalDoc: 'X1',
    sent: 1, sentDate: new Date().toISOString(), groupAck: 1, createdDate: new Date().toISOString(), ...over,
  };
}

function inputs(over: Partial<DossierInputs> = {}): DossierInputs {
  return {
    orderNo: 'SP-322263',
    nowMs: Date.now(),
    composite: { base: 'SP-322263', found: false, legs: [], lines: [] },
    edi: [],
    holds: [],
    trace: [],
    availability: [],
    shopify: null,
    sources: {},
    ...over,
  };
}

// --- assembleOrderComposite: base -> legs across open + posted ---------------

test('a shipped order (posted only) still resolves, with shipped lines and a posted leg', () => {
  const shipHeaders = [{ orderNo: 'SP-322263-1', webId: '7222087975161', shippedAt: '2026-07-21T00:00:00Z' }];
  const shipLines = [
    { orderNo: 'SP-322263-1', lineNo: 10000, sku: '10331-001-0015', description: 'Full Share Pant', location: 'HF1FTZ', shipped: 1, invoiced: 1, unitPrice: 149.99, postedAt: '2026-07-21T00:00:00Z' },
    { orderNo: 'SP-322263-1', lineNo: 20000, sku: '40125-913-0015', description: 'Tough Sun Masked Hoodie', location: 'HF1FTZ', shipped: 1, invoiced: 1, unitPrice: 59.99, postedAt: '2026-07-21T00:00:00Z' },
  ];
  const c = assembleOrderComposite('SP-322263', [], [], shipHeaders, shipLines);
  assert.equal(c.found, true);
  assert.equal(c.legs.length, 1);
  assert.equal(c.legs[0]?.presence, 'posted');
  assert.equal(c.lines.length, 2);
  assert.equal(c.lines[0]?.source, 'shipped');
});

test('base fans out to multiple legs across open + posted', () => {
  const headers = [{ orderNo: 'SP-322263-2', navStatus: 0, webId: '72', webOrder: 1, documentType: 1, isPreseason: 0, orderDate: '2026-07-20T00:00:00Z' }];
  const shipHeaders = [{ orderNo: 'SP-322263-1', webId: '72', shippedAt: '2026-07-21T00:00:00Z' }];
  const c = assembleOrderComposite('SP-322263', headers, [], shipHeaders, []);
  const legNos = c.legs.map((l) => l.orderNo).sort();
  assert.deepEqual(legNos, ['SP-322263-1', 'SP-322263-2']);
});

// --- assembleDossier: status rollup + verdict --------------------------------

test('a fully shipped order is order_status shipped, verdict green, lines invoiced', () => {
  const composite = assembleOrderComposite(
    'SP-322263', [], [],
    [{ orderNo: 'SP-322263-1', webId: '72', shippedAt: '2026-07-21T00:00:00Z' }],
    [{ orderNo: 'SP-322263-1', lineNo: 10000, sku: 'A', description: 'Pant', location: 'HF1FTZ', shipped: 1, invoiced: 1, unitPrice: 149.99, postedAt: '2026-07-21T00:00:00Z' }],
  );
  const d = assembleDossier(inputs({ composite }));
  assert.equal(d.order_status, 'shipped');
  assert.equal(d.handoff?.state, 'shipped');
  assert.equal(d.handoff?.verdict, 'green');
  assert.equal(d.lines[0]?.status, 'invoiced');
  assert.equal(d.lines[0]?.description, 'Pant');
});

test('an open order with an acked 940 and outstanding stock is with Holman, line outstanding', () => {
  const composite = assembleOrderComposite(
    'SP-900000',
    [{ orderNo: 'SP-900000-1', navStatus: 1, webId: '55', webOrder: 1, documentType: 1, isPreseason: 0, orderDate: new Date().toISOString() }],
    [{ orderNo: 'SP-900000-1', lineNo: 10000, sku: 'B', description: 'Jacket', location: 'HF1FTZ', ordered: 1, shipped: 0, invoiced: 0, outstanding: 1, unitPrice: 149.99 }],
    [], [],
  );
  const availability: NavIabcRow[] = [{ sku: 'B', location: 'HF1FTZ', channel: 'DTC', onHand: 5, available: 3, earliestShipDate: null }];
  const d = assembleDossier(inputs({ composite, availability, edi: [edi940({ docNo: 'SP-900000-1' })] }));
  assert.equal(d.order_status, 'in_progress');
  assert.equal(d.handoff?.owner, 'holman');
  assert.equal(d.lines[0]?.status, 'outstanding');
});

test('an open outstanding line with no stock anywhere is a backorder', () => {
  const composite = assembleOrderComposite(
    'SP-900001',
    [{ orderNo: 'SP-900001-1', navStatus: 1, webId: '56', webOrder: 1, documentType: 1, isPreseason: 0, orderDate: new Date().toISOString() }],
    [{ orderNo: 'SP-900001-1', lineNo: 10000, sku: 'C', description: 'Bib', location: 'HF1FTZ', ordered: 1, shipped: 0, invoiced: 0, outstanding: 1, unitPrice: 99 }],
    [], [],
  );
  const d = assembleDossier(inputs({ composite, availability: [] }));
  assert.equal(d.lines[0]?.status, 'backorder');
});

test('a partially shipped order rolls up to partial', () => {
  const composite = assembleOrderComposite(
    'SP-900002',
    [{ orderNo: 'SP-900002-1', navStatus: 1, webId: '57', webOrder: 1, documentType: 1, isPreseason: 0, orderDate: new Date().toISOString() }],
    [{ orderNo: 'SP-900002-1', lineNo: 10000, sku: 'D', description: 'Glove', location: 'HF1FTZ', ordered: 2, shipped: 0, invoiced: 0, outstanding: 2, unitPrice: 20 }],
    [{ orderNo: 'SP-900002-1', webId: '57', shippedAt: '2026-07-21T00:00:00Z' }],
    [{ orderNo: 'SP-900002-1', lineNo: 20000, sku: 'E', description: 'Hat', location: 'HF1FTZ', shipped: 1, invoiced: 1, unitPrice: 25, postedAt: '2026-07-21T00:00:00Z' }],
  );
  const d = assembleDossier(inputs({ composite }));
  assert.equal(d.order_status, 'partial');
});

test('a Shopify-cancelled order is order_status canceled and lines read canceled', () => {
  const composite = assembleOrderComposite(
    'SP-900003',
    [{ orderNo: 'SP-900003-1', navStatus: 0, webId: '58', webOrder: 1, documentType: 1, isPreseason: 0, orderDate: new Date().toISOString() }],
    [{ orderNo: 'SP-900003-1', lineNo: 10000, sku: 'F', description: 'Cap', location: 'HF1FTZ', ordered: 1, shipped: 0, invoiced: 0, outstanding: 1, unitPrice: 30 }],
    [], [],
  );
  const shopify = { line_items: [], order_total: '30', subtotal: '30', currency: 'USD', financial_status: 'refunded', fulfillment_status: 'unfulfilled', cancelled: true, cancelled_at: '2026-07-20T00:00:00Z' };
  const d = assembleDossier(inputs({ composite, shopify }));
  assert.equal(d.order_status, 'canceled');
  assert.equal(d.handoff?.state, 'canceled');
  assert.equal(d.lines[0]?.status, 'canceled');
});

test('a released order with stock and no 940 stays a red handoff failure', () => {
  const composite = assembleOrderComposite(
    'SP-900004',
    [{ orderNo: 'SP-900004-1', navStatus: 1, webId: '59', webOrder: 1, documentType: 1, isPreseason: 0, orderDate: new Date(Date.now() - 3 * 86_400_000).toISOString() }],
    [{ orderNo: 'SP-900004-1', lineNo: 10000, sku: 'G', description: 'Vest', location: 'HF1FTZ', ordered: 1, shipped: 0, invoiced: 0, outstanding: 1, unitPrice: 80 }],
    [], [],
  );
  const availability: NavIabcRow[] = [{ sku: 'G', location: 'HF1FTZ', channel: 'DTC', onHand: 9, available: 9, earliestShipDate: null }];
  const d = assembleDossier(inputs({ composite, availability, edi: [] }));
  assert.equal(d.handoff?.state, 'handoff_failed');
  assert.equal(d.handoff?.owner, 'grundens_ops');
  assert.equal(d.handoff?.verdict, 'red');
});

test('PII: a hold names the team but never leaks the comment or enteredBy', () => {
  const composite = assembleOrderComposite(
    'SP-900005',
    [{ orderNo: 'SP-900005-1', navStatus: 0, webId: '60', webOrder: 1, documentType: 1, isPreseason: 0, orderDate: new Date().toISOString() }],
    [{ orderNo: 'SP-900005-1', lineNo: 10000, sku: 'H', description: 'Sock', location: 'HF1FTZ', ordered: 1, shipped: 0, invoiced: 0, outstanding: 1, unitPrice: 10 }],
    [], [],
  );
  const holds: NavHoldRow[] = [{ holdReasonCode: 'ACCTHOLD', holdDate: new Date().toISOString(), holdComment: 'call Jane Doe 555-0100', enteredBy: 'jsmith', released: 0, autoEntry: 1 }];
  const d = assembleDossier(inputs({ composite, holds }));
  assert.equal(d.holds[0]?.owner, 'finance');
  assert.equal((d.holds[0] as unknown as Record<string, unknown>).comment, undefined);
  assert.equal(JSON.stringify(d).includes('Jane Doe'), false);
});

test('a not-found order returns not_found and a null handoff, never throws', () => {
  const d = assembleDossier(inputs());
  assert.equal(d.order_status, 'not_found');
  assert.equal(d.handoff, null);
});
