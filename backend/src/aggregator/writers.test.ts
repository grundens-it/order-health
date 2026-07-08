// Writer-seam tests (forward_sync, Unit 11 test-plan case 14). The pure verdict
// math is exercised in forwardSync.test.ts; this asserts computeForwardSyncPipeline
// maps the pure result onto the PipelineHealth row shape per the Architect field
// mapping (freshness = backlog, liveness = export liveness, watermark_lag_s = oldest
// age, pipe = 'forward_sync'), reads 'unknown' (never green) when the source is not
// wired, and honours the multi-leg presence invariant at the seam. No live sources:
// a minimal read-only NavClient exposes only the three methods the seam calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeForwardSyncPipeline, type Sources } from './writers.js';
import type { NavClient, NavForwardSyncCandidate } from '../sources/navClient.js';
import type { ForwardSyncTag } from '@order-health/shared';

function navFor(
  candidates: NavForwardSyncCandidate[] | null,
  present: string[],
  lastSuccessAt: string | null,
): NavClient {
  return {
    async getForwardSyncStagingCandidates(): Promise<NavForwardSyncCandidate[] | null> {
      return candidates;
    },
    async getNavPresentShopifyNumbers(numbers: string[]): Promise<string[]> {
      return present.filter((p) => numbers.includes(p));
    },
    async getLastForwardSyncSuccessAt(): Promise<string | null> {
      return lastSuccessAt;
    },
  } as unknown as NavClient;
}

function mkCand(name: string, minutesAgo: number, tag: ForwardSyncTag): NavForwardSyncCandidate {
  const num = name.replace(/^SP-/, '').split('-')[0] ?? null;
  return {
    shopifyOrderName: name,
    shopifyNumber: num,
    createdAt: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    tag,
    navOrderNo: null,
    status: 0,
    errorMessage: null,
  };
}

// Case 14: a red backlog maps onto the PipelineHealth columns as the Architect
// mapping specifies.
test('computeForwardSyncPipeline maps a red backlog onto the PipelineHealth columns', async () => {
  const candidates = Array.from({ length: 6 }, (_, i) =>
    mkCand(`SP-31910${i}`, 200 + i, 'shopify_exported'),
  );
  const sources = {
    nav: navFor(candidates, [], '2000-01-01T00:00:00.000Z'),
    middleware: {},
  } as unknown as Sources;

  const row = await computeForwardSyncPipeline(sources);

  assert.equal(row.pipe, 'forward_sync');
  assert.equal(row.freshness_verdict, 'red'); // freshness column carries the backlog verdict
  assert.equal(row.pipe_verdict, 'red');
  assert.ok((row.watermark_lag_s ?? 0) > 0); // watermark_lag_s = oldest backlog age
  assert.equal(row.last_progress_at, row.heartbeat_at); // both = last_success_at
  const detail = row.detail as { backlog_count: number; coverage: string; sample: unknown[] };
  assert.equal(detail.backlog_count, 6);
  assert.equal(detail.coverage, 'staging');
  assert.ok(detail.sample.length > 0);
});

// US-7 at the seam: a null (not wired) candidate source reads 'unknown', not green.
test('computeForwardSyncPipeline reads unknown (not green) when the source is not wired', async () => {
  const sources = { nav: navFor(null, [], null), middleware: {} } as unknown as Sources;
  const row = await computeForwardSyncPipeline(sources);
  assert.equal(row.freshness_verdict, 'unknown');
  assert.notEqual(row.pipe_verdict, 'green');
});

// US-1 multi-leg invariant at the seam: an order present via its -2 leg (bare <n>
// in navPresent) is not counted in the backlog.
test('computeForwardSyncPipeline: an order present via its -2 leg is not in the backlog', async () => {
  const candidates = [mkCand('SP-319241', 300, 'shopify_exported')];
  const sources = {
    nav: navFor(candidates, ['319241'], '2026-07-07T17:55:00.000Z'),
    middleware: {},
  } as unknown as Sources;
  const row = await computeForwardSyncPipeline(sources);
  const detail = row.detail as { backlog_count: number };
  assert.equal(detail.backlog_count, 0);
  assert.equal(row.freshness_verdict, 'green');
});
