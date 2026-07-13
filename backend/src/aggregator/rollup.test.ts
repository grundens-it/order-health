// Verdict-correctness tests for the Leadership rollup (design.md section 6, Unit
// 6). No live source: every case is SEEDED pipeline + order rows through the pure
// computeRollup. Run with `npm test` (node:test). Mirrors inventorySync.test.ts:
// assert each headline at its boundary plus the derivation of oldest-stuck-age
// and inventory-sync-fresh.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrderHealth, PipelineHealth, Verdict } from '@order-health/shared';
import { computeRollup } from './rollup.js';

// A pipe row with a given pipe_verdict; freshness defaults to match unless set.
function pipe(pipeKey: string, verdict: Verdict, freshness: Verdict = verdict): PipelineHealth {
  return {
    pipe: pipeKey,
    pipe_verdict: verdict,
    freshness_verdict: freshness,
    watermark_lag_s: null,
    last_progress_at: null,
    liveness_verdict: verdict,
    heartbeat_at: null,
    heartbeat_age_s: null,
    detail: {},
  };
}

// A neutral pipe (ADR-0008): disabled or idle-no-traffic, carried in detail.
function neutralPipe(
  pipeKey: string,
  applicability: 'disabled' | 'idle_no_traffic',
  verdict: Verdict = 'green',
): PipelineHealth {
  return { ...pipe(pipeKey, verdict), detail: { applicability } };
}

// An order row with a given verdict and optional stuck age.
function order(verdict: Verdict, oldestStuckAgeS: number | null = null): OrderHealth {
  return {
    channel: 'dtc',
    nav_order_no: null,
    shopify_order_id: null,
    shopify_order_name: null,
    customer_ref: null,
    current_stage: 'nav_staging',
    order_verdict: verdict,
    oldest_stuck_age_s: oldestStuckAgeS,
    is_orphan_suspect: false,
    note: null,
  };
}

// --- Headline bucket boundaries -------------------------------------------
test('healthy: all pipes and orders green => healthy / green chip', () => {
  const r = computeRollup([pipe('inventory_sync', 'green')], [order('green'), order('green')]);
  assert.equal(r.headline, 'healthy');
  assert.equal(r.headline_verdict, 'green');
});

test('at_risk: an amber pipe (no reds) => at_risk / amber chip', () => {
  const r = computeRollup(
    [pipe('inventory_sync', 'green'), pipe('back_sync', 'amber')],
    [order('green')],
  );
  assert.equal(r.headline, 'at_risk');
  assert.equal(r.headline_verdict, 'amber');
});

test('at_risk: an amber order (no reds) => at_risk / amber chip', () => {
  const r = computeRollup([pipe('inventory_sync', 'green')], [order('green'), order('amber')]);
  assert.equal(r.headline, 'at_risk');
  assert.equal(r.headline_verdict, 'amber');
});

test('stuck: any red pipe => stuck / red chip', () => {
  const r = computeRollup(
    [pipe('inventory_sync', 'green'), pipe('back_sync', 'red')],
    [order('green')],
  );
  assert.equal(r.headline, 'stuck');
  assert.equal(r.headline_verdict, 'red');
});

test('stuck: any red (SLO-breached) order => stuck / red chip', () => {
  const r = computeRollup([pipe('inventory_sync', 'green')], [order('amber'), order('red', 4200)]);
  assert.equal(r.headline, 'stuck');
  assert.equal(r.headline_verdict, 'red');
});

test('red dominates amber: a red order outranks amber pipes', () => {
  const r = computeRollup(
    [pipe('inventory_sync', 'amber'), pipe('back_sync', 'amber')],
    [order('red', 100)],
  );
  assert.equal(r.headline, 'stuck');
});

// --- Unknown handling: not-yet-observed never fakes at-risk or hides green --
test('unknown pipes do not move a green board off healthy', () => {
  // The real scaffold state: inventory_sync green, the other five pipes unknown
  // placeholders. Unknown is "not observed", so the headline stays healthy/green.
  const r = computeRollup(
    [
      pipe('inventory_sync', 'green'),
      pipe('back_sync', 'unknown'),
      pipe('price_sync', 'unknown'),
    ],
    [order('green')],
  );
  assert.equal(r.headline, 'healthy');
  assert.equal(r.headline_verdict, 'green');
});

test('empty snapshot => healthy-empty: healthy bucket with an unknown chip', () => {
  // Documented boundary: nothing unhealthy observed, but nothing observed yet, so
  // the chip discloses 'unknown' rather than a false green.
  const r = computeRollup([], []);
  assert.equal(r.headline, 'healthy');
  assert.equal(r.headline_verdict, 'unknown');
  assert.equal(r.oldest_stuck_age_s, null);
  assert.equal(r.inventory_sync_fresh, null);
  assert.equal(r.counts.orders_total, 0);
  assert.equal(r.counts.pipes_total, 0);
});

test('all-unknown pipes (nothing observed) => healthy-empty unknown chip', () => {
  const r = computeRollup([pipe('inventory_sync', 'unknown')], []);
  assert.equal(r.headline, 'healthy');
  assert.equal(r.headline_verdict, 'unknown');
});

// --- ADR-0008: neutral (disabled / idle) pipes do not drag the rollup ------
test('a disabled pipe does not drag the headline and is excluded from the counts', () => {
  // The live-run case: price_sync disabled, everything else green. Old code let
  // the disabled/unknown pipe pollute the rollup; now it is neutral.
  const r = computeRollup(
    [pipe('inventory_sync', 'green'), neutralPipe('price_sync', 'disabled')],
    [order('green')],
  );
  assert.equal(r.headline, 'healthy');
  assert.equal(r.headline_verdict, 'green');
  assert.equal(r.counts.pipes_total, 1); // only the active pipe counts
  assert.equal(r.counts.pipes_green, 1);
});

test('an idle-no-traffic webhook pipe is neutral, not counted unknown', () => {
  const r = computeRollup(
    [pipe('inventory_sync', 'green'), neutralPipe('shopify_webhook', 'idle_no_traffic')],
    [order('green')],
  );
  assert.equal(r.headline, 'healthy');
  assert.equal(r.counts.pipes_total, 1);
  assert.equal(r.counts.pipes_unknown, 0);
});

test('a neutral pipe never masks a real red elsewhere', () => {
  const r = computeRollup(
    [pipe('back_sync', 'red'), neutralPipe('price_sync', 'disabled')],
    [order('green')],
  );
  assert.equal(r.headline, 'stuck');
  assert.equal(r.headline_verdict, 'red');
});

// --- Oldest stuck age selection -------------------------------------------
test('oldest_stuck_age_s selects the MAX age across red orders only', () => {
  const r = computeRollup(
    [pipe('inventory_sync', 'green')],
    [order('red', 3600), order('red', 9000), order('amber', 99999)],
  );
  // 9000 is the oldest red; the amber's larger age is ignored (not stuck).
  assert.equal(r.oldest_stuck_age_s, 9000);
});

test('oldest_stuck_age_s is null when there are no red orders', () => {
  const r = computeRollup([pipe('inventory_sync', 'green')], [order('amber', 500), order('green')]);
  assert.equal(r.oldest_stuck_age_s, null);
});

test('oldest_stuck_age_s ignores red orders with a null age', () => {
  const r = computeRollup(
    [pipe('inventory_sync', 'green')],
    [order('red', null), order('red', 1200)],
  );
  assert.equal(r.oldest_stuck_age_s, 1200);
});

// --- Inventory-sync-fresh derivation --------------------------------------
test('inventory_sync_fresh true when the inventory_sync freshness is green', () => {
  const r = computeRollup([pipe('inventory_sync', 'amber', 'green')], []);
  // pipe rolled up amber, but FRESHNESS specifically is green => fresh.
  assert.equal(r.inventory_sync_fresh, true);
});

test('inventory_sync_fresh false when freshness is stale (amber or red)', () => {
  assert.equal(
    computeRollup([pipe('inventory_sync', 'amber', 'amber')], []).inventory_sync_fresh,
    false,
  );
  assert.equal(
    computeRollup([pipe('inventory_sync', 'red', 'red')], []).inventory_sync_fresh,
    false,
  );
});

test('inventory_sync_fresh null when the pipe is absent or freshness unknown', () => {
  assert.equal(computeRollup([pipe('back_sync', 'green')], []).inventory_sync_fresh, null);
  assert.equal(
    computeRollup([pipe('inventory_sync', 'unknown', 'unknown')], []).inventory_sync_fresh,
    null,
  );
});

// --- Counts ----------------------------------------------------------------
test('counts tally each layer by verdict', () => {
  const r = computeRollup(
    [pipe('inventory_sync', 'green'), pipe('back_sync', 'amber'), pipe('price_sync', 'unknown')],
    [order('green'), order('green'), order('red', 10), order('amber')],
  );
  assert.equal(r.counts.pipes_total, 3);
  assert.equal(r.counts.pipes_green, 1);
  assert.equal(r.counts.pipes_amber, 1);
  assert.equal(r.counts.pipes_unknown, 1);
  assert.equal(r.counts.orders_total, 4);
  assert.equal(r.counts.orders_green, 2);
  assert.equal(r.counts.orders_amber, 1);
  assert.equal(r.counts.orders_red, 1);
});
