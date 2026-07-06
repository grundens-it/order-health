// Verdict-correctness tests for the Shopify Webhook Monitor (design.md 5, 5.127).
// Two failure modes: per-topic staleness (cycle-banded last-received) and the
// subscription-removal signal (a removed/absent subscription is amber-or-worse,
// the WAF-removal failure mode). Every case is a SEEDED input through the pure
// computeShopifyWebhook.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeShopifyWebhook,
  type ShopifyWebhookInput,
  type ShopifyWebhookThresholds,
} from './shopifyWebhook.js';

const NOW = Date.parse('2026-07-05T18:00:00.000Z');

// cycle 1h, green<1c, amber 1-4c, red>=4c.
const T: ShopifyWebhookThresholds = {
  cycleSeconds: 3600,
  freshnessAmberCycles: 1,
  freshnessRedCycles: 4,
};

function ago(secondsAgo: number): string {
  return new Date(NOW - secondsAgo * 1000).toISOString();
}

function subscribed(topic: string, secondsAgo: number): ShopifyWebhookInput['topics'][number] {
  return { topic, lastReceivedAt: ago(secondsAgo), subscribed: true };
}

// --- Per-topic freshness boundary ------------------------------------------
test('freshness: all topics received within one cycle => green pipe', () => {
  const input: ShopifyWebhookInput = {
    topics: [subscribed('orders/create', 300), subscribed('orders/updated', 600)],
  };
  const r = computeShopifyWebhook(input, T, NOW);
  assert.equal(r.freshnessVerdict, 'green');
  assert.equal(r.pipeVerdict, 'green');
});

test('freshness: a one-cycle-stale topic is amber (worst topic wins)', () => {
  const input: ShopifyWebhookInput = {
    topics: [subscribed('orders/create', 300), subscribed('orders/updated', 3600)],
  };
  const r = computeShopifyWebhook(input, T, NOW);
  assert.equal(r.freshnessVerdict, 'amber');
});

test('freshness: a four-cycle-stale topic reds the pipe', () => {
  const input: ShopifyWebhookInput = {
    topics: [subscribed('orders/create', 300), subscribed('orders/updated', 4 * 3600)],
  };
  const r = computeShopifyWebhook(input, T, NOW);
  assert.equal(r.freshnessVerdict, 'red');
  assert.equal(r.pipeVerdict, 'red');
});

// --- Subscription-removal signal (amber-or-worse) --------------------------
test('subscription removed => at least AMBER even when receipts are fresh', () => {
  const input: ShopifyWebhookInput = {
    topics: [
      subscribed('orders/create', 300),
      { topic: 'fulfillments/create', lastReceivedAt: ago(300), subscribed: false },
    ],
  };
  const r = computeShopifyWebhook(input, T, NOW);
  assert.equal(r.subscriptionVerdict, 'amber');
  assert.equal(r.pipeVerdict, 'amber'); // fresh receipts cannot pull it back to green
  assert.equal(r.detail.missing_subscription_count, 1);
});

test('subscription removal never reads green: the removed topic verdict is amber-or-worse', () => {
  const input: ShopifyWebhookInput = {
    topics: [{ topic: 'orders/create', lastReceivedAt: ago(60), subscribed: false }],
  };
  const r = computeShopifyWebhook(input, T, NOW);
  const removed = r.detail.topics.find((t) => t.topic === 'orders/create');
  assert.ok(removed);
  assert.notEqual(removed?.verdict, 'green');
  assert.equal(removed?.verdict, 'amber');
});

test('a removed subscription on a RED-stale topic stays red (worst wins over amber)', () => {
  const input: ShopifyWebhookInput = {
    topics: [{ topic: 'orders/create', lastReceivedAt: ago(4 * 3600), subscribed: false }],
  };
  const r = computeShopifyWebhook(input, T, NOW);
  assert.equal(r.detail.topics[0]?.verdict, 'red');
  assert.equal(r.pipeVerdict, 'red');
});

test('all subscribed => green subscription verdict', () => {
  const input: ShopifyWebhookInput = {
    topics: [subscribed('orders/create', 300), subscribed('orders/updated', 300)],
  };
  const r = computeShopifyWebhook(input, T, NOW);
  assert.equal(r.subscriptionVerdict, 'green');
});

// --- Empty + detail --------------------------------------------------------
test('no topics yet => unknown, not a false green', () => {
  const r = computeShopifyWebhook({ topics: [] }, T, NOW);
  assert.equal(r.freshnessVerdict, 'unknown');
  assert.equal(r.subscriptionVerdict, 'unknown');
  assert.equal(r.pipeVerdict, 'unknown');
});

test('detail surfaces per-topic last-received plus freshest/stalest', () => {
  const input: ShopifyWebhookInput = {
    topics: [subscribed('orders/create', 300), subscribed('orders/updated', 1800)],
  };
  const r = computeShopifyWebhook(input, T, NOW);
  assert.equal(r.detail.topics.length, 2);
  assert.equal(r.detail.topics[0]?.last_received_age_s, 300);
  assert.equal(r.detail.freshest_received_at, ago(300));
  assert.equal(r.detail.stalest_received_at, ago(1800));
});
