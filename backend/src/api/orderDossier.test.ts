// Tests for the single-order dossier assembler (ADR-0012). assembleDossier is pure, so
// these are seeded inputs in, asserted dossier out: no live NAV or middleware. They pin
// the two things that matter: the verdict is the SAME classifyHandoff result the board
// uses, and PII cannot appear in the payload.
import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleDossier, type DossierInputs } from './orderDossier.js';
import type {
  NavEdiSendRow,
  NavHoldRow,
  NavIabcRow,
  NavOrderLifecycleRow,
  NavOrderLine,
  NavTraceRow,
} from '../sources/navClient.js';

const HOLMAN = '2538727140';
const DAY = 86_400_000;

function lifecycle(over: Partial<NavOrderLifecycleRow> = {}): NavOrderLifecycleRow {
  return {
    channel: 'dtc',
    navOrderNo: 'SP-322263-1',
    webId: '7223212441849',
    webOrder: 1,
    shopifyOrderName: '#1024',
    customerRef: 'C0004821 ACME OUTFITTERS', // PII-ish; must NOT surface in the dossier
    shopifyOrderAt: null,
    allocatorSplitAt: null,
    navStagingAt: null,
    navStagingStatus: null,
    navPromotionAt: null,
    navShipmentAt: null,
    backSyncAt: null,
    missedBackSync: false,
    documentType: 1,
    isPreseason: false,
    navStatus: 1,
    orderAt: new Date(Date.now() - 1 * DAY).toISOString(),
    ...over,
  };
}

function edi940(over: Partial<NavEdiSendRow> = {}): NavEdiSendRow {
  return {
    docNo: 'SP-322263-1',
    tradePartner: HOLMAN,
    ediDoc: '940',
    internalDoc: 'X1',
    sent: 1,
    sentDate: new Date().toISOString(),
    groupAck: 1,
    createdDate: new Date().toISOString(),
    ...over,
  };
}

function inputs(over: Partial<DossierInputs> = {}): DossierInputs {
  return {
    orderNo: 'SP-322263-1',
    nowMs: Date.now(),
    lifecycle: lifecycle(),
    outstandingLines: [{ orderNo: 'SP-322263-1', sku: 'A100', location: 'HF1FTZ', outstandingQty: 1 }] as NavOrderLine[],
    shippedLines: [],
    edi: [edi940()],
    holds: [],
    trace: [],
    availability: [
      { sku: 'A100', location: 'HF1FTZ', channel: 'DTC', onHand: 12, available: 8, earliestShipDate: null },
    ] as NavIabcRow[],
    shopify: null,
    sources: { nav_lifecycle: 'ok' },
    ...over,
  };
}

test('acked 940 inside Holman window: with_holman, green, edi block sent+acked', () => {
  const d = assembleDossier(inputs());
  assert.equal(d.handoff?.state, 'with_holman');
  assert.equal(d.handoff?.owner, 'holman');
  assert.equal(d.handoff?.verdict, 'green');
  assert.equal(d.edi?.present, true);
  assert.equal(d.edi?.sent, true);
  assert.equal(d.edi?.acked, true);
});

test('acked 940 past Holman window: holman_delayed, amber risk', () => {
  const old = new Date(Date.now() - 10 * DAY).toISOString();
  const d = assembleDossier(inputs({ lifecycle: lifecycle({ orderAt: old }) }));
  assert.equal(d.handoff?.state, 'holman_delayed');
  assert.equal(d.handoff?.owner, 'holman');
  assert.equal(d.handoff?.verdict, 'amber');
  assert.equal(d.handoff?.label, 'Holman delay');
});

test('released, stock on hand, no 940 at all: handoff_failed, red, ours', () => {
  const old = new Date(Date.now() - 3 * DAY).toISOString();
  const d = assembleDossier(inputs({ edi: [], lifecycle: lifecycle({ orderAt: old }) }));
  assert.equal(d.handoff?.state, 'handoff_failed');
  assert.equal(d.handoff?.owner, 'grundens_ops');
  assert.equal(d.handoff?.verdict, 'red');
  assert.equal(d.edi, null);
});

test('a NAV hold names the owning team and never leaks the free-text comment', () => {
  const holds: NavHoldRow[] = [
    {
      holdReasonCode: 'ACCTHOLD',
      holdDate: new Date().toISOString(),
      holdComment: 'call Jane Doe at 555-0100 re: overdue balance', // PII: must not surface
      enteredBy: 'jsmith',
      released: 0,
      autoEntry: 1,
    },
  ];
  const d = assembleDossier(inputs({ edi: [], holds }));
  assert.equal(d.holds[0]?.reason_code, 'ACCTHOLD');
  assert.equal(d.holds[0]?.owner, 'finance');
  // The hold block carries no comment or enteredBy field at all.
  assert.equal((d.holds[0] as unknown as Record<string, unknown>).comment, undefined);
  assert.equal((d.holds[0] as unknown as Record<string, unknown>).entered_by, undefined);
});

test('PII: the identity block exposes no customer name, only the allowed keys', () => {
  const d = assembleDossier(inputs());
  assert.ok(d.identity);
  const keys = Object.keys(d.identity).sort();
  assert.deepEqual(keys, [
    'channel',
    'in_open_board',
    'nav_order_no',
    'order_at',
    'preseason',
    'released',
    'shopify_order_id',
    'shopify_order_name',
  ]);
  // The serialized dossier must not contain the customer ref anywhere.
  assert.equal(JSON.stringify(d).includes('ACME OUTFITTERS'), false);
});

test('an order absent from the board yields a null identity but still classifies', () => {
  const d = assembleDossier(inputs({ lifecycle: null, edi: [], availability: [] }));
  assert.equal(d.identity, null);
  assert.ok(d.handoff); // still gets a verdict (in_flight / backorder), never throws
});

test('availability is limited to HF1FTZ and TAC and passes the sources map through', () => {
  const availability: NavIabcRow[] = [
    { sku: 'A100', location: 'HF1FTZ', channel: 'DTC', onHand: 5, available: 3, earliestShipDate: null },
    { sku: 'A100', location: 'TAC', channel: 'DTC', onHand: 2, available: 0, earliestShipDate: null },
    { sku: 'A100', location: 'ZZZ', channel: 'DTC', onHand: 9, available: 9, earliestShipDate: null },
  ];
  const d = assembleDossier(inputs({ availability, sources: { nav_lifecycle: 'ok', shopify_order: 'not_found' } }));
  const locs = d.availability.map((a) => a.location).sort();
  assert.deepEqual(locs, ['HF1FTZ', 'TAC']);
  assert.equal(d.sources.shopify_order, 'not_found');
});

test('the allocator EL- skip is detected from the trace and drives the code-defect state', () => {
  const trace: NavTraceRow[] = [
    {
      entryAt: new Date().toISOString(),
      decisionPoint: 'EL.NoHoldNoRelease',
      itemNo: 'A100',
      locationCode: 'HF1FTZ',
      branchTaken: 'skip',
      detail: 'EL- order: hold/auto-release skipped (pending CalcATP fix)',
    },
  ];
  // No EDI, unreleased, no hold: the EL- skip is the explanation.
  const d = assembleDossier(
    inputs({ edi: [], trace, lifecycle: lifecycle({ navStatus: 0 }) }),
  );
  assert.equal(d.handoff?.state, 'blocked_code_defect');
  assert.equal(d.handoff?.owner, 'engineering');
  assert.equal(d.allocator[0]?.decision_point, 'EL.NoHoldNoRelease');
});
