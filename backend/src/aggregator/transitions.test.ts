// Verdict-transition diff tests (Unit 7, design.md 8). No DB: every case is a
// SEEDED (previous, current, open) triple through the PURE diffTransitions, the
// same node:test structure inventorySync.test.ts uses.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  diffTransitions,
  isUnhealthy,
  type OpenTransition,
  type VerdictSubject,
} from './transitions.js';

const NOW = '2026-07-05T18:00:00.000Z';

function pipe(subjectKey: string, verdict: VerdictSubject['verdict']): VerdictSubject {
  return { subjectKind: 'pipe', subjectKey, verdict };
}
function open(subjectKey: string): OpenTransition {
  return { subjectKind: 'pipe', subjectKey };
}

// --- Open on newly-red -----------------------------------------------------
test('opens a transition when a subject goes green -> red', () => {
  const actions = diffTransitions(
    [pipe('inventory_sync', 'green')],
    [pipe('inventory_sync', 'red')],
    [],
    NOW,
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].op, 'open');
  assert.equal(actions[0].subjectKey, 'inventory_sync');
  if (actions[0].op === 'open') {
    assert.equal(actions[0].from_verdict, 'green');
    assert.equal(actions[0].to_verdict, 'red');
    assert.equal(actions[0].opened_at, NOW);
  }
});

test('opens with from_verdict unknown when the subject was not in the previous snapshot', () => {
  const actions = diffTransitions([], [pipe('back_sync', 'red')], [], NOW);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].op, 'open');
  if (actions[0].op === 'open') assert.equal(actions[0].from_verdict, 'unknown');
});

// --- Amber handling --------------------------------------------------------
test('opens on newly-amber (amber is an unhealthy open condition)', () => {
  const actions = diffTransitions(
    [pipe('price_sync', 'green')],
    [pipe('price_sync', 'amber')],
    [],
    NOW,
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].op, 'open');
  if (actions[0].op === 'open') assert.equal(actions[0].to_verdict, 'amber');
});

test('amber -> red while ALREADY open does not open a duplicate row', () => {
  const actions = diffTransitions(
    [pipe('allocator', 'amber')],
    [pipe('allocator', 'red')],
    [open('allocator')], // already has an open row
    NOW,
  );
  assert.equal(actions.length, 0);
});

// --- No duplicate open while already red -----------------------------------
test('still-red with an open row produces no action (no duplicate open)', () => {
  const actions = diffTransitions(
    [pipe('inventory_sync', 'red')],
    [pipe('inventory_sync', 'red')],
    [open('inventory_sync')],
    NOW,
  );
  assert.equal(actions.length, 0);
});

// --- Resolve on return-to-green --------------------------------------------
test('resolves the open row when a subject returns to green', () => {
  const actions = diffTransitions(
    [pipe('inventory_sync', 'red')],
    [pipe('inventory_sync', 'green')],
    [open('inventory_sync')],
    NOW,
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].op, 'resolve');
  if (actions[0].op === 'resolve') assert.equal(actions[0].resolved_at, NOW);
});

test('return to green with NO open row does nothing (never a phantom resolve)', () => {
  const actions = diffTransitions(
    [pipe('inventory_sync', 'green')],
    [pipe('inventory_sync', 'green')],
    [],
    NOW,
  );
  assert.equal(actions.length, 0);
});

// --- unknown is never an open or resolve condition -------------------------
test('unknown never opens (a source not yet reporting is not a transition)', () => {
  const actions = diffTransitions(
    [pipe('shopify_webhook', 'green')],
    [pipe('shopify_webhook', 'unknown')],
    [],
    NOW,
  );
  assert.equal(actions.length, 0);
});

test('unknown with an open row does not resolve it (only green resolves)', () => {
  const actions = diffTransitions(
    [pipe('shopify_webhook', 'red')],
    [pipe('shopify_webhook', 'unknown')],
    [open('shopify_webhook')],
    NOW,
  );
  assert.equal(actions.length, 0);
});

// --- Mixed set: open one, resolve another, ignore a third ------------------
test('a mixed snapshot opens, resolves and ignores independently', () => {
  const actions = diffTransitions(
    [pipe('a', 'green'), pipe('b', 'red'), pipe('c', 'green')],
    [pipe('a', 'red'), pipe('b', 'green'), pipe('c', 'green')],
    [open('b')],
    NOW,
  );
  const byKey = new Map(actions.map((x) => [x.subjectKey, x.op]));
  assert.equal(byKey.get('a'), 'open');
  assert.equal(byKey.get('b'), 'resolve');
  assert.equal(byKey.has('c'), false);
  assert.equal(actions.length, 2);
});

test('isUnhealthy: amber/red true, green/unknown false', () => {
  assert.equal(isUnhealthy('red'), true);
  assert.equal(isUnhealthy('amber'), true);
  assert.equal(isUnhealthy('green'), false);
  assert.equal(isUnhealthy('unknown'), false);
});
