// Verdict-correctness tests for the per-location availability divergence monitor
// (WI2 #88). No live NAV / middleware: every case is a SEEDED input through the
// pure computeFsLocationDivergence. Run with `npm test` (node:test).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeFsLocationDivergence,
  type FsDivergenceThresholds,
  type FsLocationDivergenceInput,
  type NavLocationAvailabilityRow,
} from './fsLocationDivergence.js';

const NOW = Date.parse('2026-07-18T18:00:00.000Z');

// Mirrors config.fsDivergence: amber at 1 diverged SKU, red at 5.
const T: FsDivergenceThresholds = { divergedAmberCount: 1, divergedRedCount: 5 };

function nav(sku: string, available: number | null, earliest: string | null = null): NavLocationAvailabilityRow {
  return { sku, available, onHand: available, earliestShipmentDate: earliest };
}

function input(overrides: Partial<FsLocationDivergenceInput> = {}): FsLocationDivergenceInput {
  return {
    navAtLocation: [],
    fsAvailBySku: new Map(),
    navLocation: 'HF1FTZ',
    fsSource: 'middleware /api/nav/inventory-sync/fulfillment-service-info',
    fsSourceIsProxy: true,
    ...overrides,
  };
}

// --- Unread FS source is unknown, never a false green -----------------------
test('a null FS source grades unknown, not a false green', () => {
  const r = computeFsLocationDivergence(input({ fsAvailBySku: null }), T, NOW);
  assert.equal(r.divergenceVerdict, 'unknown');
  assert.equal(r.detail.checked, null);
  assert.equal(r.detail.diverged_count, null);
});

// --- The incident condition: NAV stocked at HF1FTZ, FS reads 0 --------------
test('one SKU NAV-stocked at HF1FTZ but FS reads 0 diverges (amber at 1)', () => {
  const r = computeFsLocationDivergence(
    input({
      navAtLocation: [nav('50625-425', 12)],
      fsAvailBySku: new Map([['50625-425', 0]]),
    }),
    T,
    NOW,
  );
  assert.equal(r.detail.checked, 1);
  assert.equal(r.detail.diverged_count, 1);
  assert.equal(r.divergenceVerdict, 'amber');
  assert.equal(r.detail.items[0]?.sku, '50625-425');
  assert.equal(r.detail.items[0]?.nav_available, 12);
  assert.equal(r.detail.items[0]?.fs_available, 0);
});

test('a NEGATIVE FS availability (floor-at-zero) also counts as diverged', () => {
  const r = computeFsLocationDivergence(
    input({ navAtLocation: [nav('X', 5)], fsAvailBySku: new Map([['X', -3]]) }),
    T,
    NOW,
  );
  assert.equal(r.detail.diverged_count, 1);
});

test('a full diverging size run reds the pipe at the red count', () => {
  const skus = ['A', 'B', 'C', 'D', 'E'];
  const r = computeFsLocationDivergence(
    input({
      navAtLocation: skus.map((s) => nav(s, 8)),
      fsAvailBySku: new Map(skus.map((s) => [s, 0])),
    }),
    T,
    NOW,
  );
  assert.equal(r.detail.diverged_count, 5);
  assert.equal(r.divergenceVerdict, 'red');
});

// --- No divergence => green -------------------------------------------------
test('FS holding the stock (positive) is not a divergence => green', () => {
  const r = computeFsLocationDivergence(
    input({ navAtLocation: [nav('A', 10)], fsAvailBySku: new Map([['A', 10]]) }),
    T,
    NOW,
  );
  assert.equal(r.detail.checked, 1);
  assert.equal(r.detail.diverged_count, 0);
  assert.equal(r.divergenceVerdict, 'green');
});

test('present FS source but nothing NAV-stocked => green (nothing to diverge)', () => {
  const r = computeFsLocationDivergence(
    input({ navAtLocation: [nav('A', 0)], fsAvailBySku: new Map([['A', 0]]) }),
    T,
    NOW,
  );
  assert.equal(r.detail.checked, 0); // available <= 0 is not eligible
  assert.equal(r.divergenceVerdict, 'green');
});

// --- Only compare SKUs the FS side actually reported ------------------------
test('a NAV-stocked SKU absent from the FS read is NOT counted (cannot assert divergence)', () => {
  const r = computeFsLocationDivergence(
    input({ navAtLocation: [nav('A', 10)], fsAvailBySku: new Map([['B', 0]]) }),
    T,
    NOW,
  );
  assert.equal(r.detail.checked, 0); // A not in the FS map => skipped
  assert.equal(r.divergenceVerdict, 'green');
});

// --- Earliest Shipment Date gating (when the ship date is known) ------------
test('a future Earliest Shipment Date excludes the SKU (not yet shippable, not a divergence)', () => {
  const future = new Date(NOW + 7 * 86_400_000).toISOString();
  const r = computeFsLocationDivergence(
    input({ navAtLocation: [nav('A', 10, future)], fsAvailBySku: new Map([['A', 0]]) }),
    T,
    NOW,
  );
  assert.equal(r.detail.checked, 0);
  assert.equal(r.divergenceVerdict, 'green');
});

test('a past Earliest Shipment Date is shippable now and still diverges', () => {
  const past = new Date(NOW - 86_400_000).toISOString();
  const r = computeFsLocationDivergence(
    input({ navAtLocation: [nav('A', 10, past)], fsAvailBySku: new Map([['A', 0]]) }),
    T,
    NOW,
  );
  assert.equal(r.detail.diverged_count, 1);
  assert.equal(r.divergenceVerdict, 'amber');
});

// --- Source provenance is surfaced (clean vs proxy) -------------------------
test('the FS source + proxy flag are carried into the detail for the panel + audit', () => {
  const r = computeFsLocationDivergence(input(), T, NOW);
  assert.equal(r.detail.nav_location, 'HF1FTZ');
  assert.match(r.detail.fs_source, /fulfillment-service-info/);
  assert.equal(r.detail.fs_source_is_proxy, true);
});
