// Shopify Webhook Monitor: last-received per topic + subscription-removal signal
// (design.md 3 line 85 and 5 line 127). Two failure modes:
//   1. staleness  - a topic with no delivery in its expected window (cycle-banded
//                   freshness of last-received per topic).
//   2. subscription removal - a removed / absent webhook subscription (the
//      19-consecutive-4xx WAF-removal failure mode). A missing subscription is an
//      AMBER-or-worse condition by rule, independent of freshness.
//
// The pipe verdict is the worst per-topic freshness verdict rolled up with the
// subscription verdict. PURE: no I/O, no clock read beyond nowMs.
import type {
  ShopifyWebhookDetail,
  Verdict,
  WebhookTopicHealth,
} from '@order-health/shared';
import { worstVerdict } from '@order-health/shared';

export interface ShopifyWebhookThresholds {
  cycleSeconds: number;          // one expected-delivery window
  freshnessAmberCycles: number;  // last-received age >= this many cycles => AMBER
  freshnessRedCycles: number;    // last-received age >= this many cycles => RED
}

// Seeded, source-shaped input: one entry per subscribed/expected topic. A topic
// that should exist but whose subscription was removed is present with
// subscribed === false (that is the signal, not an omission from the list).
export interface WebhookTopicInput {
  topic: string;
  lastReceivedAt: string | null;
  subscribed: boolean;
}

export interface ShopifyWebhookInput {
  topics: WebhookTopicInput[];
}

export interface ShopifyWebhookResult {
  freshnessVerdict: Verdict;      // worst per-topic last-received freshness
  subscriptionVerdict: Verdict;   // amber-or-worse when any subscription is removed
  pipeVerdict: Verdict;           // worst of the two
  detail: ShopifyWebhookDetail;
}

// Age in seconds of an ISO timestamp relative to nowMs. null-safe.
function ageSeconds(iso: string | null, nowMs: number): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

// A cycle-banded verdict: green under amberCycles, amber up to redCycles, red at
// or beyond redCycles. A null age is 'unknown' (topic not yet reporting).
function cycleBandVerdict(
  ageS: number | null,
  cycleSeconds: number,
  amberCycles: number,
  redCycles: number,
): Verdict {
  if (ageS === null) return 'unknown';
  if (ageS >= redCycles * cycleSeconds) return 'red';
  if (ageS >= amberCycles * cycleSeconds) return 'amber';
  return 'green';
}

// The webhook compute. Per topic: a freshness verdict on last-received. Across
// topics: an AMBER subscription verdict when any expected subscription is
// removed. The pipe is the worst of the freshness rollup and the subscription
// verdict, so a removed subscription can never read GREEN (design.md 5 line 127).
export function computeShopifyWebhook(
  input: ShopifyWebhookInput,
  thresholds: ShopifyWebhookThresholds,
  nowMs: number,
): ShopifyWebhookResult {
  const topics: WebhookTopicHealth[] = input.topics.map((t) => {
    const ageS = ageSeconds(t.lastReceivedAt, nowMs);
    // ADR-0008: a SUBSCRIBED topic with no receipt in the window is quiet, not
    // broken. It reads a neutral GREEN and is flagged idle_no_traffic, instead of
    // 'unknown' (a null age) which dragged the whole pipe to unknown in the live
    // run. A topic that HAS a last-received timestamp is graded on freshness as
    // before, so a busy topic that goes stale still ambers/reds.
    const idle = t.subscribed && t.lastReceivedAt === null;
    const freshness = idle
      ? 'green'
      : cycleBandVerdict(
          ageS,
          thresholds.cycleSeconds,
          thresholds.freshnessAmberCycles,
          thresholds.freshnessRedCycles,
        );
    // A removed subscription is amber-or-worse for that topic (the real WAF-removal
    // failure mode); it never reads greener than the topic's freshness would.
    const verdict = t.subscribed ? freshness : worstVerdict([freshness, 'amber']);
    return {
      topic: t.topic,
      last_received_at: t.lastReceivedAt,
      last_received_age_s: ageS,
      subscribed: t.subscribed,
      verdict,
      idle_no_traffic: idle,
    };
  });

  const freshnessVerdict = worstVerdict(topics.map((t) => t.verdict));
  const idleTopicCount = topics.filter((t) => t.idle_no_traffic === true).length;

  const missingSubscriptionCount = topics.filter((t) => !t.subscribed).length;
  // Subscription-removal signal: amber-or-worse whenever any expected topic has
  // no live subscription. Green only when every expected topic is subscribed;
  // unknown when there are no topics to reason about yet.
  let subscriptionVerdict: Verdict;
  if (topics.length === 0) {
    subscriptionVerdict = 'unknown';
  } else if (missingSubscriptionCount > 0) {
    subscriptionVerdict = 'amber';
  } else {
    subscriptionVerdict = 'green';
  }

  const receivedTimes = topics
    .map((t) => t.last_received_at)
    .filter((v): v is string => v !== null)
    .map((v) => ({ iso: v, ms: Date.parse(v) }))
    .filter((v) => !Number.isNaN(v.ms));

  const freshest =
    receivedTimes.length === 0
      ? null
      : receivedTimes.reduce((a, b) => (b.ms > a.ms ? b : a)).iso;
  const stalest =
    receivedTimes.length === 0
      ? null
      : receivedTimes.reduce((a, b) => (b.ms < a.ms ? b : a)).iso;

  // The pipe is idle_no_traffic (neutral) only when EVERY subscribed topic is
  // quiet and no subscription is missing: nothing to report, not a broken pipe.
  // With any fresh traffic the pipe is 'active' (the fresh topics make it green);
  // with a missing subscription it stays 'active' so the amber is not neutralized.
  const subscribedCount = topics.filter((t) => t.subscribed).length;
  const applicability =
    missingSubscriptionCount === 0 && subscribedCount > 0 && idleTopicCount === subscribedCount
      ? 'idle_no_traffic'
      : 'active';

  const detail: ShopifyWebhookDetail = {
    topics,
    missing_subscription_count: missingSubscriptionCount,
    freshest_received_at: freshest,
    stalest_received_at: stalest,
    applicability,
    idle_topic_count: idleTopicCount,
  };

  return {
    freshnessVerdict,
    subscriptionVerdict,
    pipeVerdict: worstVerdict([freshnessVerdict, subscriptionVerdict]),
    detail,
  };
}
