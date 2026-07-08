// Verdict-correctness tests for the Forward Sync Monitor (forward-sync-test-plan.md
// section 3, QA seat). No live NAV / middleware: every case is a SEEDED input
// through the pure computeForwardSync. Run with `npm test` (node:test).
//
// Covers test-plan cases 1-13 and 15 (pure compute). Case 14 (the writer-seam
// column mapping) is verified in Phase C, not here.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ForwardSyncTag } from '@order-health/shared';
import {
  computeForwardSync,
  type ForwardSyncCandidate,
  type ForwardSyncInput,
  type ForwardSyncThresholds,
} from './forwardSync.js';

// Fixed clock so every age is deterministic.
const NOW = Date.parse('2026-07-07T18:00:00.000Z');

// ADR-0006 defaults (grace 30, backlog amber 30 / red 120, amber count 1 / red
// count 5, liveness amber 60 / red 180, no date floor).
function mkThresholds(overrides: Partial<ForwardSyncThresholds> = {}): ForwardSyncThresholds {
  return {
    graceMinutes: 30,
    backlogAmberMinutes: 30,
    backlogRedMinutes: 120,
    backlogAmberCount: 1,
    backlogRedCount: 5,
    livenessAmberMinutes: 60,
    livenessRedMinutes: 180,
    dateFloorIso: '',
    ...overrides,
  };
}

// An ISO timestamp `minutes` before NOW.
function agoIso(minutes: number): string {
  return new Date(NOW - minutes * 60000).toISOString();
}

// A seeded backlog candidate. createdAt defaults to `ageMinutes` before NOW;
// shopifyNumber is derived from the name (SP-319121 => 319121) unless overridden.
function mkCandidate(
  name: string,
  ageMinutes: number,
  tag: ForwardSyncTag = 'shopify_exported',
  opts: { createdAt?: string | null; shopifyNumber?: string } = {},
): ForwardSyncCandidate {
  return {
    shopifyOrderName: name,
    shopifyNumber: opts.shopifyNumber ?? name.replace(/^SP-/, ''),
    createdAt: opts.createdAt !== undefined ? opts.createdAt : agoIso(ageMinutes),
    tag,
  };
}

// Assemble a ForwardSyncInput. Defaults: source wired, phase-1 coverage, empty
// NAV presence, no liveness signal.
function mkInput(overrides: Partial<ForwardSyncInput> = {}): ForwardSyncInput {
  return {
    candidates: [],
    navPresent: new Set<string>(),
    lastSuccessAt: null,
    coverage: 'staging',
    sourced: true,
    ...overrides,
  };
}

// 1 --- source wired + zero candidates => freshness green, staging coverage -----
test('1: source wired with zero exported-pending orders is green backlog, staging coverage', () => {
  const r = computeForwardSync(mkInput(), mkThresholds(), NOW);
  assert.equal(r.freshnessVerdict, 'green');
  assert.equal(r.detail.coverage, 'staging');
  assert.equal(r.detail.backlog_count, 0);
});

// 2 --- unsourced => unknown, pipe not green (US-7) -----------------------------
test('2: unsourced candidate set reads unknown backlog and the pipe is not green', () => {
  const r = computeForwardSync(mkInput({ sourced: false }), mkThresholds(), NOW);
  assert.equal(r.freshnessVerdict, 'unknown');
  assert.notEqual(r.pipeVerdict, 'green');
});

// 3 --- one absent order just past grace => amber by the count floor, never green
test('3: one absent order 31 min old is amber (count floor), never green (US-2/US-3)', () => {
  const r = computeForwardSync(
    mkInput({ candidates: [mkCandidate('SP-319121', 31)] }),
    mkThresholds(),
    NOW,
  );
  assert.equal(r.freshnessVerdict, 'amber');
  assert.notEqual(r.freshnessVerdict, 'green');
  assert.equal(r.detail.backlog_count, 1);
});

// 4 --- one absent order below grace => excluded --------------------------------
test('4: one absent order 10 min old (below grace) is excluded, backlog empty, green', () => {
  const r = computeForwardSync(
    mkInput({ candidates: [mkCandidate('SP-319121', 10)] }),
    mkThresholds(),
    NOW,
  );
  assert.equal(r.detail.backlog_count, 0);
  assert.equal(r.freshnessVerdict, 'green');
});

// 5 --- one absent order past red age => red at count 1 -------------------------
test('5: one absent order >= 120 min is red at count 1 (US-3)', () => {
  const r = computeForwardSync(
    mkInput({ candidates: [mkCandidate('SP-319121', 120)] }),
    mkThresholds(),
    NOW,
  );
  assert.equal(r.freshnessVerdict, 'red');
});

// 6 --- five young absent orders => red by count band ---------------------------
test('6: five absent orders past grace but under red-age go red by the count band (US-3)', () => {
  const candidates = [0, 1, 2, 3, 4].map((i) => mkCandidate(`SP-32000${i}`, 40 + i));
  const r = computeForwardSync(mkInput({ candidates }), mkThresholds(), NOW);
  assert.equal(r.detail.backlog_count, 5);
  assert.equal(r.freshnessVerdict, 'red');
});

// 7 --- one absent order before the date floor => excluded (US-8) ---------------
test('7: an order created before dateFloorIso is excluded (US-8)', () => {
  const r = computeForwardSync(
    mkInput({ candidates: [mkCandidate('SP-311050', 60)] }),
    mkThresholds({ dateFloorIso: agoIso(30) }), // floor is more recent than the order
    NOW,
  );
  assert.equal(r.detail.backlog_count, 0);
  assert.equal(r.freshnessVerdict, 'green');
});

// 8 --- one candidate present in navPresent => excluded (happy path, US-1) ------
test('8: a candidate whose number is present in NAV is excluded (US-1 happy path)', () => {
  const r = computeForwardSync(
    mkInput({
      candidates: [mkCandidate('SP-319121', 45)],
      navPresent: new Set(['319121']),
    }),
    mkThresholds(),
    NOW,
  );
  assert.equal(r.detail.backlog_count, 0);
  assert.equal(r.freshnessVerdict, 'green');
});

// 9 --- multi-leg presence: <n> present via its -2 leg => counted present -------
test('9: SP-319241 present only via its -2 leg counts as present (correlation on <n>)', () => {
  // navPresent is keyed on the bare number 319241 (the writer strips the leg), so
  // an order present via any leg is present.
  const r = computeForwardSync(
    mkInput({
      candidates: [mkCandidate('SP-319241', 45)],
      navPresent: new Set(['319241']),
    }),
    mkThresholds(),
    NOW,
  );
  assert.equal(r.detail.backlog_count, 0);
  assert.equal(r.freshnessVerdict, 'green');
});

// 10 --- liveness bands (US-6) --------------------------------------------------
test('10a: null last_success_at is liveness unknown, never red (US-6)', () => {
  const r = computeForwardSync(mkInput({ lastSuccessAt: null }), mkThresholds(), NOW);
  assert.equal(r.livenessVerdict, 'unknown');
  assert.notEqual(r.livenessVerdict, 'red');
});

test('10b: last_success_at 90 min ago is liveness amber (US-6)', () => {
  const r = computeForwardSync(
    mkInput({ lastSuccessAt: agoIso(90) }),
    mkThresholds(),
    NOW,
  );
  assert.equal(r.livenessVerdict, 'amber');
});

test('10c: last_success_at 200 min ago is liveness red (US-6)', () => {
  const r = computeForwardSync(
    mkInput({ lastSuccessAt: agoIso(200) }),
    mkThresholds(),
    NOW,
  );
  assert.equal(r.livenessVerdict, 'red');
});

// 11 --- rollup: green backlog + red liveness => red pipe (US-10) ---------------
test('11: green backlog with red liveness rolls the pipe up to red (US-10)', () => {
  const r = computeForwardSync(
    mkInput({ lastSuccessAt: agoIso(200) }), // no candidates => backlog green
    mkThresholds(),
    NOW,
  );
  assert.equal(r.freshnessVerdict, 'green');
  assert.equal(r.livenessVerdict, 'red');
  assert.equal(r.pipeVerdict, 'red');
});

// 12 --- contiguous_block window (US-4) ----------------------------------------
test('12a: >= red-count orders clustered inside one grace window sets contiguous_block', () => {
  // Ages 40..44 min: a 4-minute span, well inside the 30-minute grace window.
  const candidates = [40, 41, 42, 43, 44].map((m, i) => mkCandidate(`SP-31912${i}`, m));
  const r = computeForwardSync(mkInput({ candidates }), mkThresholds(), NOW);
  assert.equal(r.detail.contiguous_block, true);
});

test('12b: red-count orders spread across hours does not set contiguous_block', () => {
  // Ages 40..360 min: a 320-minute span, far wider than one grace window.
  const candidates = [40, 120, 200, 280, 360].map((m, i) => mkCandidate(`SP-31912${i}`, m));
  const r = computeForwardSync(mkInput({ candidates }), mkThresholds(), NOW);
  assert.equal(r.detail.contiguous_block, false);
});

// 13 --- sample cap + oldest-first ordering (US-5) ------------------------------
test('13: forty backlog orders yield a 25-row sample, oldest first', () => {
  // Ages 40..79 min, all past grace. Oldest (79 min) must lead the sample.
  const candidates = Array.from({ length: 40 }, (_, i) =>
    mkCandidate(`SP-3200${String(i).padStart(2, '0')}`, 40 + i),
  );
  const r = computeForwardSync(mkInput({ candidates }), mkThresholds(), NOW);
  assert.equal(r.detail.backlog_count, 40);
  assert.equal(r.detail.sample.length, 25);
  assert.equal(r.detail.sample[0].age_s, r.detail.oldest_age_s);
  assert.equal(r.detail.sample[0].age_s, 79 * 60);
  // Oldest-first: each row is at least as old as the next.
  for (let i = 1; i < r.detail.sample.length; i += 1) {
    assert.ok((r.detail.sample[i - 1].age_s ?? 0) >= (r.detail.sample[i].age_s ?? 0));
  }
});

// 15 --- phase-1 green result is labeled staging coverage (ADR-0006) ------------
test('15: a phase-1 green result carries staging coverage (honest green label)', () => {
  // Empty backlog + a fresh last-success => a genuinely green pipe.
  const r = computeForwardSync(mkInput({ lastSuccessAt: agoIso(5) }), mkThresholds(), NOW);
  assert.equal(r.pipeVerdict, 'green');
  assert.equal(r.detail.coverage, 'staging');
});
