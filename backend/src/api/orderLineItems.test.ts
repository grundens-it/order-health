// Unit tests for the Line-items DIAGNOSE body-builder (GET /api/diagnostics/
// shopify-order/:id). Mirrors remediationClientBody.test.ts: a pure function, a
// range of real middleware shapes in, a normalized { line_items } out. No live call.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOrderLineItems } from './orderLineItems.js';

test('extracts sku, quantity and name from a bare Shopify order object', () => {
  const out = buildOrderLineItems({
    id: 458812,
    line_items: [
      { sku: 'ABC-123', quantity: 2, name: 'Neptune Jacket - L' },
      { sku: 'XYZ-9', quantity: 1, name: 'Deck Boot - 10' },
    ],
  });
  assert.deepEqual(out, {
    line_items: [
      { sku: 'ABC-123', quantity: 2, name: 'Neptune Jacket - L' },
      { sku: 'XYZ-9', quantity: 1, name: 'Deck Boot - 10' },
    ],
  });
});

test('tolerates the { order: { ... } } envelope', () => {
  const out = buildOrderLineItems({ order: { line_items: [{ sku: 'S1', quantity: 3, name: 'Bib' }] } });
  assert.deepEqual(out, { line_items: [{ sku: 'S1', quantity: 3, name: 'Bib' }] });
});

test('builds a name from title + variant_title when name is absent', () => {
  const out = buildOrderLineItems({
    line_items: [{ sku: 'S2', quantity: 1, title: 'Storm Jacket', variant_title: 'XL / Red' }],
  });
  assert.deepEqual(out, { line_items: [{ sku: 'S2', quantity: 1, name: 'Storm Jacket (XL / Red)' }] });
});

test('falls back to title alone when there is no variant_title', () => {
  const out = buildOrderLineItems({ line_items: [{ sku: 'S3', quantity: 1, title: 'Gloves' }] });
  assert.deepEqual(out, { line_items: [{ sku: 'S3', quantity: 1, name: 'Gloves' }] });
});

test('missing sku becomes an empty string and a bad quantity becomes 0', () => {
  const out = buildOrderLineItems({ line_items: [{ quantity: 'oops', name: 'Mystery' }] });
  assert.deepEqual(out, { line_items: [{ sku: '', quantity: 0, name: 'Mystery' }] });
});

test('coerces a numeric sku to a string', () => {
  const out = buildOrderLineItems({ line_items: [{ sku: 12345, quantity: 1, name: 'Numeric SKU' }] });
  assert.deepEqual(out, { line_items: [{ sku: '12345', quantity: 1, name: 'Numeric SKU' }] });
});

test('a malformed / empty payload yields an empty list, never throws', () => {
  assert.deepEqual(buildOrderLineItems(null), { line_items: [] });
  assert.deepEqual(buildOrderLineItems('nope'), { line_items: [] });
  assert.deepEqual(buildOrderLineItems({}), { line_items: [] });
  assert.deepEqual(buildOrderLineItems({ line_items: 'not-an-array' }), { line_items: [] });
  assert.deepEqual(buildOrderLineItems({ line_items: [null, 7] }), { line_items: [] });
});
