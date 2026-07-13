// Unit tests for the read-only Shopify Admin client (ADR-0009). No network: the
// mutation guard, the token request builder, the URL builders, the token-expiry
// predicate, and the GraphQL-body mappers are all pure.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { config as Config } from '../config.js';
import {
  assertNoMutation,
  buildGraphqlUrl,
  buildTokenRequest,
  mapFulfillmentStates,
  mapInventoryLevels,
  mapRecentOrders,
  mapVariantPrices,
  tokenExpired,
} from './shopifyClient.js';

const SHOP: (typeof Config)['shopify'] = {
  authMode: 'client_credentials',
  shop: 'grundens.myshopify.com',
  apiVersion: '2025-01',
  clientId: 'client-abc',
  clientSecret: 'secret-xyz',
};

// --- Mutation guard (read-only defence in depth) ---------------------------
test('assertNoMutation rejects a mutation and allows a query', () => {
  assert.throws(() => assertNoMutation('mutation { orderUpdate(input: {}) { order { id } } }'));
  assert.throws(() => assertNoMutation('  mutation Foo { x }'));
  assert.throws(() =>
    assertNoMutation('query A { a }\n} mutation B { b }'), // a second mutation op
  );
  assert.doesNotThrow(() => assertNoMutation('query { orders(first: 1) { edges { node { name } } } }'));
  // The word "mutation" inside a field/string is not an operation and is allowed.
  assert.doesNotThrow(() => assertNoMutation('query { shop { name } } # no mutation here'));
});

// --- Token request builder (client-credentials) ----------------------------
test('buildTokenRequest posts client-credentials to the shop OAuth endpoint', () => {
  const req = buildTokenRequest(SHOP);
  assert.equal(req.url, 'https://grundens.myshopify.com/admin/oauth/access_token');
  assert.equal(req.body.client_id, 'client-abc');
  assert.equal(req.body.client_secret, 'secret-xyz');
  assert.equal(req.body.grant_type, 'client_credentials');
});

test('buildGraphqlUrl targets the configured shop + API version', () => {
  assert.equal(
    buildGraphqlUrl(SHOP),
    'https://grundens.myshopify.com/admin/api/2025-01/graphql.json',
  );
  // Tolerates a scheme / trailing slash in the shop value.
  assert.equal(
    buildGraphqlUrl({ ...SHOP, shop: 'https://grundens.myshopify.com/' }),
    'https://grundens.myshopify.com/admin/api/2025-01/graphql.json',
  );
});

// --- Token expiry predicate ------------------------------------------------
test('tokenExpired: no token is expired; within margin is expired; fresh is not', () => {
  const now = Date.parse('2026-07-13T18:00:00Z');
  assert.equal(tokenExpired(null, null, now), true); // never fetched
  // fetched 24h ago, 24h ttl -> well past, expired.
  assert.equal(tokenExpired(now - 24 * 3600 * 1000, 24 * 3600, now), true);
  // fetched 1 min ago, 24h ttl -> fresh.
  assert.equal(tokenExpired(now - 60 * 1000, 24 * 3600, now), false);
  // within the 5-min refresh margin of expiry -> treated as expired.
  assert.equal(tokenExpired(now - (24 * 3600 - 200) * 1000, 24 * 3600, now), true);
});

// --- GraphQL body mappers --------------------------------------------------
test('mapFulfillmentStates reads name + fulfillment status (fulfilled vs not)', () => {
  const body = {
    data: {
      orders: {
        edges: [
          { node: { name: 'SP-319090', displayFulfillmentStatus: 'FULFILLED' } },
          { node: { name: 'SP-319091', displayFulfillmentStatus: 'UNFULFILLED' } },
          { node: { name: 'SP-319092', displayFulfillmentStatus: 'PARTIALLY_FULFILLED' } },
        ],
      },
    },
  };
  const r = mapFulfillmentStates(body);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], { orderName: 'SP-319090', fulfilled: true, displayStatus: 'FULFILLED' });
  assert.equal(r[1]?.fulfilled, false);
  assert.equal(r[2]?.fulfilled, true); // partially fulfilled counts as fulfilled
  assert.deepEqual(mapFulfillmentStates({}), []); // empty body -> []
});

test('mapInventoryLevels sums per-SKU available across locations (quantities[] and legacy available)', () => {
  const body = {
    data: {
      productVariants: {
        edges: [
          {
            node: {
              sku: 'NEPTUNE-L',
              inventoryItem: {
                inventoryLevels: {
                  edges: [
                    { node: { location: { name: 'TAC' }, quantities: [{ quantity: 4 }] } },
                    { node: { location: { name: 'OLD' }, available: 6 } },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };
  const r = mapInventoryLevels(body);
  assert.equal(r.length, 2);
  assert.equal(r[0]?.available, 4);
  assert.equal(r[1]?.available, 6);
  assert.equal(r[0]?.sku, 'NEPTUNE-L');
});

test('mapRecentOrders reads name + createdAt', () => {
  const body = {
    data: { orders: { edges: [{ node: { name: '#1024', createdAt: '2026-07-13T17:00:00Z' } }] } },
  };
  const r = mapRecentOrders(body);
  assert.equal(r[0]?.name, '#1024');
  assert.equal(r[0]?.createdAt, '2026-07-13T17:00:00Z');
});

test('mapVariantPrices reads sku + price', () => {
  const body = {
    data: { productVariants: { edges: [{ node: { sku: 'NEPTUNE-L', price: '129.00' } }] } },
  };
  const r = mapVariantPrices(body);
  assert.equal(r[0]?.sku, 'NEPTUNE-L');
  assert.equal(r[0]?.price, 129);
});
