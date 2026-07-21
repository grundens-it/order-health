// Tests for the reshaped health model. Every case is a SEEDED HandoffFacts through the
// pure classifier: no NAV, no middleware. The rules these pin are the ones the business
// stated, so a regression here is a regression in what "unhealthy" means.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACK_GRACE_DAYS,
  HANDOFF_GRACE_DAYS,
  HOLMAN_SLA_DAYS,
  classifyHandoff,
  holdOwnerFor,
  rollupHandoff,
  type HandoffFacts,
} from './orderHandoffClass.js';

// A healthy, boring baseline: released, handed off, acknowledged.
function facts(over: Partial<HandoffFacts> = {}): HandoffFacts {
  return {
    isPreseason: false,
    released: true,
    ediSent: true,
    ediAcked: true,
    ediDocExists: true,
    activeHoldReason: null,
    autoReleaseSkipped: false,
    hasStock: true,
    ageDays: 5,
    ...over,
  };
}

// --- The headline rule: TRUST THE EDI --------------------------------------

test('an acked 940 is owned by Holman and never red, no matter how old', () => {
  for (const ageDays of [1, 15, 90]) {
    const r = classifyHandoff(facts({ ageDays }));
    assert.equal(r.owner, 'holman');
    assert.notEqual(r.verdict, 'red', `age ${ageDays} must not turn red`);
  }
});

test('an acked 940 inside Holman\'s ship window is green', () => {
  const r = classifyHandoff(facts({ ageDays: HOLMAN_SLA_DAYS }));
  assert.equal(r.state, 'with_holman');
  assert.equal(r.verdict, 'green');
});

// A Holman delay is a customer-facing RISK we want visible, but it is not our defect
// and must never be counted as "stuck" or offered a re-drive.
test('an acked 940 past Holman\'s ship window is AMBER risk, still owned by Holman', () => {
  const r = classifyHandoff(facts({ ageDays: HOLMAN_SLA_DAYS + 1 }));
  assert.equal(r.state, 'holman_delayed');
  assert.equal(r.owner, 'holman');
  assert.equal(r.verdict, 'amber');
});

test('an acked 940 stays non-red even when NAV still shows the header unreleased', () => {
  // Observed live: 197 orders had a sent+acked 940 but an Open-looking header.
  // EDI is the truth for handoff, not the header status.
  const r = classifyHandoff(facts({ released: false, ageDays: 40 }));
  assert.equal(r.state, 'holman_delayed');
  assert.equal(r.owner, 'holman');
  assert.notEqual(r.verdict, 'red');
});

test('age ALONE never makes anything red', () => {
  const aged = [
    facts({ ageDays: 365 }),                                   // with Holman
    facts({ ageDays: 365, ediSent: false, ediAcked: false, ediDocExists: false, hasStock: false }), // backorder
    facts({ ageDays: 365, isPreseason: true }),                // preseason
  ];
  for (const f of aged) {
    assert.notEqual(classifyHandoff(f).verdict, 'red', JSON.stringify(f));
  }
});

// --- Preseason is a different animal ---------------------------------------

test('preseason is excluded from active order health outright', () => {
  const r = classifyHandoff(facts({ isPreseason: true, ediSent: false, ediAcked: false, ediDocExists: false, ageDays: 200 }));
  assert.equal(r.state, 'preseason');
  assert.equal(r.verdict, 'excluded');
  assert.equal(r.owner, 'none');
});

// --- Our defects: the handoff itself failed --------------------------------

test('released with stock and no 940 past the grace window is OUR defect', () => {
  const r = classifyHandoff(facts({
    ediSent: false, ediAcked: false, ediDocExists: false,
    ageDays: HANDOFF_GRACE_DAYS + 3,
  }));
  assert.equal(r.state, 'handoff_failed');
  assert.equal(r.owner, 'grundens_ops');
  assert.equal(r.verdict, 'red');
});

test('a 940 created but never sent is OUR defect', () => {
  const r = classifyHandoff(facts({ ediSent: false, ediAcked: false, ediDocExists: true }));
  assert.equal(r.state, 'handoff_failed');
  assert.equal(r.owner, 'grundens_ops');
  assert.equal(r.verdict, 'red');
});

test('940 sent but unacked is in flight briefly, then becomes our defect', () => {
  const fresh = classifyHandoff(facts({ ediAcked: false, ageDays: ACK_GRACE_DAYS - 1 }));
  assert.equal(fresh.state, 'awaiting_ack');
  assert.equal(fresh.verdict, 'green');

  const stale = classifyHandoff(facts({ ediAcked: false, ageDays: ACK_GRACE_DAYS + 1 }));
  assert.equal(stale.state, 'handoff_failed');
  assert.equal(stale.verdict, 'red');
});

// --- Holds are work queues, not pipeline defects ---------------------------

test('hold reason codes route to the owning team and never grade red', () => {
  const cases: [string, string][] = [
    ['ACCTHOLD', 'finance'],
    ['ACCTPREPAY', 'finance'],
    ['ACCTCONT', 'finance'],
    ['CS', 'customer_service'],
    ['CSHOLD', 'customer_service'],
    ['CONTACTBO', 'customer_service'],
  ];
  for (const [code, owner] of cases) {
    assert.equal(holdOwnerFor(code), owner, code);
    const r = classifyHandoff(facts({
      ediSent: false, ediAcked: false, ediDocExists: false,
      activeHoldReason: code, ageDays: 30,
    }));
    assert.equal(r.owner, owner, code);
    assert.equal(r.verdict, 'amber', `${code} is a work queue, never red`);
  }
});

test('an unknown hold code still routes to a human rather than being dropped', () => {
  assert.equal(holdOwnerFor('SOMETHINGNEW'), 'customer_service');
});

// --- The known code defect (EL- / CU 5790) ---------------------------------

test('the EL- autorelease skip is an engineering-owned known defect, not per-order ops', () => {
  const r = classifyHandoff(facts({
    ediSent: false, ediAcked: false, ediDocExists: false,
    autoReleaseSkipped: true, released: false, ageDays: 42,
  }));
  assert.equal(r.state, 'blocked_code_defect');
  assert.equal(r.owner, 'engineering');
  assert.equal(r.verdict, 'amber');
  assert.match(r.reason, /5790/);
});

test('an active hold outranks the autorelease skip (the hold is the actionable reason)', () => {
  const r = classifyHandoff(facts({
    ediSent: false, ediAcked: false, ediDocExists: false,
    activeHoldReason: 'ACCTHOLD', autoReleaseSkipped: true, ageDays: 30,
  }));
  assert.equal(r.owner, 'finance');
});

// --- Genuine supply waits ---------------------------------------------------

test('no stock anywhere is a backorder, not a defect', () => {
  const r = classifyHandoff(facts({
    ediSent: false, ediAcked: false, ediDocExists: false,
    hasStock: false, ageDays: 60,
  }));
  assert.equal(r.state, 'backorder');
  assert.equal(r.verdict, 'green');
});

test('a brand new order is in flight, not a defect', () => {
  const r = classifyHandoff(facts({
    ediSent: false, ediAcked: false, ediDocExists: false,
    ageDays: 0,
  }));
  assert.equal(r.state, 'in_flight');
  assert.equal(r.verdict, 'green');
});

// --- Rollup ----------------------------------------------------------------

test('rollup: only genuine defects drive red, preseason is excluded from the counts', () => {
  const rows = [
    classifyHandoff(facts({ ageDays: 1 })),                              // with Holman, in window
    classifyHandoff(facts({ ageDays: 40 })),                             // Holman delay, amber risk
    classifyHandoff(facts({ isPreseason: true })),                       // excluded
    classifyHandoff(facts({ ediSent: false, ediAcked: false, ediDocExists: false, activeHoldReason: 'ACCTHOLD' })), // amber
    classifyHandoff(facts({ ediSent: false, ediAcked: false, ediDocExists: true })), // red
  ];
  const r = rollupHandoff(rows);
  assert.equal(r.defects, 1);
  assert.equal(r.ownedElsewhere, 2); // the Finance hold and the Holman delay
  assert.equal(r.healthy, 1);
  assert.equal(r.excluded, 1);
  assert.equal(r.verdict, 'red');
});

// A backlog sitting with Holman is NEVER our defect, so it never reds. Past their ship
// window it is a risk worth seeing, so the fleet reads amber, not green.
test('rollup: a fleet entirely with Holman never reds; past their window it is amber risk', () => {
  const inWindow = Array.from({ length: 900 }, () => classifyHandoff(facts({ ageDays: 1 })));
  const rIn = rollupHandoff(inWindow);
  assert.equal(rIn.defects, 0);
  assert.equal(rIn.verdict, 'green');
  assert.equal(rIn.healthy, 900);

  const late = Array.from({ length: 900 }, () => classifyHandoff(facts({ ageDays: 45 })));
  const rLate = rollupHandoff(late);
  assert.equal(rLate.defects, 0, 'Holman being behind is never OUR defect');
  assert.equal(rLate.verdict, 'amber');
  assert.equal(rLate.ownedElsewhere, 900);
});

test('rollup: work-queue holds surface as amber, never as a pipeline failure', () => {
  const rows = Array.from({ length: 60 }, () =>
    classifyHandoff(facts({ ediSent: false, ediAcked: false, ediDocExists: false, activeHoldReason: 'ACCTPREPAY' })),
  );
  const r = rollupHandoff(rows);
  assert.equal(r.verdict, 'amber');
  assert.equal(r.defects, 0);
});
