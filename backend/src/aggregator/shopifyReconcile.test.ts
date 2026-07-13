// Unit tests for the pure Shopify reconciliation functions (ADR-0007 / ADR-0009).
// No network. Each asserts: a match reconciles clean, a real divergence is
// surfaced with the exact key, and an empty Shopify read reads unavailable
// (unknown), never a false "reconciled".
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconcileBackSync,
  reconcileInventory,
  reconcilePrice,
  reconcileWebhookOutcome,
} from './shopifyReconcile.js';

// --- back_sync: NAV shipment posted vs Shopify fulfillment ------------------
test('reconcileBackSync: a NAV shipment with no Shopify fulfillment is a divergence', () => {
  const states = [
    { orderName: 'SP-1', fulfilled: true, displayStatus: 'FULFILLED' },
    { orderName: 'SP-2', fulfilled: false, displayStatus: 'UNFULFILLED' },
  ];
  const r = reconcileBackSync(['SP-1', 'SP-2'], states);
  assert.equal(r.available, true);
  assert.equal(r.checked, 2);
  assert.equal(r.reconciled, false);
  assert.equal(r.divergences.length, 1);
  assert.equal(r.divergences[0]?.key, 'SP-2');
});

test('reconcileBackSync: all fulfilled reconciles clean; empty Shopify read is unavailable', () => {
  const r = reconcileBackSync(['SP-1'], [{ orderName: 'SP-1', fulfilled: true, displayStatus: 'FULFILLED' }]);
  assert.equal(r.reconciled, true);
  assert.equal(r.divergences.length, 0);
  const none = reconcileBackSync(['SP-1'], []);
  assert.equal(none.available, false);
  assert.equal(none.reconciled, false); // unavailable is not "reconciled"
});

// --- inventory_sync: NAV availability vs Shopify levels ---------------------
test('reconcileInventory: a SKU whose Shopify qty differs from NAV is a divergence', () => {
  const nav = new Map([
    ['A', 10],
    ['B', 5],
  ]);
  const levels = [
    { sku: 'A', locationName: 'TAC', available: 10 }, // matches
    { sku: 'B', locationName: 'TAC', available: 2 }, // diverges (5 vs 2)
  ];
  const r = reconcileInventory(nav, levels);
  assert.equal(r.checked, 2);
  assert.equal(r.divergences.length, 1);
  assert.equal(r.divergences[0]?.key, 'B');
  assert.equal(r.divergences[0]?.nav, 5);
  assert.equal(r.divergences[0]?.shopify, 2);
});

test('reconcileInventory: sums Shopify locations per SKU and respects tolerance', () => {
  const nav = new Map([['A', 10]]);
  const levels = [
    { sku: 'A', locationName: 'TAC', available: 6 },
    { sku: 'A', locationName: 'OLD', available: 4 }, // 6+4 = 10 == NAV
  ];
  assert.equal(reconcileInventory(nav, levels).reconciled, true);
  // within tolerance
  const near = [{ sku: 'A', locationName: 'TAC', available: 9 }];
  assert.equal(reconcileInventory(nav, near, 1).divergences.length, 0);
  assert.equal(reconcileInventory(nav, near, 0).divergences.length, 1);
});

test('reconcileInventory: empty Shopify read is unavailable (unknown), not reconciled', () => {
  const r = reconcileInventory(new Map([['A', 1]]), []);
  assert.equal(r.available, false);
  assert.equal(r.reconciled, false);
});

// --- price_sync: NAV price vs Shopify price spot-check ----------------------
test('reconcilePrice: a price drift beyond tolerance is a divergence', () => {
  const nav = new Map([
    ['A', 129.0],
    ['B', 59.0],
  ]);
  const shop = [
    { sku: 'A', price: 129.0, currency: 'USD' },
    { sku: 'B', price: 49.0, currency: 'USD' }, // drift
  ];
  const r = reconcilePrice(nav, shop);
  assert.equal(r.divergences.length, 1);
  assert.equal(r.divergences[0]?.key, 'B');
});

test('reconcilePrice: sub-cent difference within tolerance reconciles clean', () => {
  const r = reconcilePrice(new Map([['A', 129.0]]), [{ sku: 'A', price: 129.004, currency: 'USD' }]);
  assert.equal(r.reconciled, true);
});

// --- shopify_webhook outcome: Shopify order vs NAV arrival ------------------
test('reconcileWebhookOutcome: a Shopify order with no NAV arrival is a divergence', () => {
  const orders = [
    { name: 'SP-1', createdAt: '2026-07-13T17:00:00Z' },
    { name: 'SP-2', createdAt: '2026-07-13T17:05:00Z' },
  ];
  const arrived = new Set(['SP-1']);
  const r = reconcileWebhookOutcome(orders, arrived);
  assert.equal(r.checked, 2);
  assert.equal(r.divergences.length, 1);
  assert.equal(r.divergences[0]?.key, 'SP-2');
});

test('reconcileWebhookOutcome: all arrived reconciles clean; no Shopify orders is unavailable', () => {
  assert.equal(reconcileWebhookOutcome([{ name: 'SP-1', createdAt: null }], new Set(['SP-1'])).reconciled, true);
  assert.equal(reconcileWebhookOutcome([], new Set(['SP-1'])).available, false);
});
