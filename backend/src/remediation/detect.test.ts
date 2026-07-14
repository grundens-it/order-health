// Failure-mode tool detection tests (issue #35). The detection is a PURE function
// of a pipe's observed verdicts + typed detail bag: no DB, no live source, no
// trigger. We assert the failure-mode -> tool mapping per subject, that every
// detected toolId resolves to a registered tool, and that the registry helper
// falls back to the static primary when detection does not fire.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PipelineHealth, Verdict } from '@order-health/shared';
import { detectRemediationTool } from '@order-health/shared';
import {
  REMEDIATION_MAPPINGS,
  getRemediationTool,
  recommendedToolForSubject,
} from './registry.js';

// A minimal PipelineHealth builder: green everywhere with an empty detail bag,
// overridden per case. Only the fields detection reads need to be meaningful.
function pipe(pipeKey: string, over: Partial<PipelineHealth>): PipelineHealth {
  const green: Verdict = 'green';
  return {
    pipe: pipeKey,
    pipe_verdict: green,
    freshness_verdict: green,
    watermark_lag_s: null,
    last_progress_at: null,
    liveness_verdict: green,
    heartbeat_at: null,
    heartbeat_age_s: null,
    detail: {},
    ...over,
  };
}

// --- inventory_sync: three failure modes, three tools ----------------------
test('inventory_sync: watcher liveness RED -> atomic_watcher_restart', () => {
  const d = detectRemediationTool('inventory_sync', pipe('inventory_sync', { liveness_verdict: 'red' }));
  assert.equal(d?.toolId, 'atomic_watcher_restart');
});

test('inventory_sync: watermark stale (freshness) but watcher alive -> clear_cu50007_job', () => {
  const d = detectRemediationTool(
    'inventory_sync',
    pipe('inventory_sync', { freshness_verdict: 'red', liveness_verdict: 'green' }),
  );
  assert.equal(d?.toolId, 'clear_cu50007_job');
});

test('inventory_sync: dry-run divergence AMBER -> reconcile_audit', () => {
  const d = detectRemediationTool(
    'inventory_sync',
    pipe('inventory_sync', {
      freshness_verdict: 'green',
      liveness_verdict: 'green',
      detail: { divergence: { divergence_verdict: 'amber' } },
    }),
  );
  assert.equal(d?.toolId, 'reconcile_audit');
});

test('inventory_sync: all green -> no detection (fall back to static primary)', () => {
  assert.equal(detectRemediationTool('inventory_sync', pipe('inventory_sync', {})), null);
});

// --- back_sync: backlog vs single miss vs stale watcher --------------------
test('back_sync: backlog (>=2 missed) -> recovery_sweep (batch)', () => {
  const d = detectRemediationTool('back_sync', pipe('back_sync', { detail: { missed_count: 5 } }));
  assert.equal(d?.toolId, 'recovery_sweep');
});

test('back_sync: exactly one missed -> submit_fulfillment_request (single)', () => {
  const d = detectRemediationTool('back_sync', pipe('back_sync', { detail: { missed_count: 1 } }));
  assert.equal(d?.toolId, 'submit_fulfillment_request');
});

test('back_sync: no backlog but watcher stale -> back_sync_run_now', () => {
  const d = detectRemediationTool(
    'back_sync',
    pipe('back_sync', { detail: { missed_count: 0 }, liveness_verdict: 'red' }),
  );
  assert.equal(d?.toolId, 'back_sync_run_now');
});

test('back_sync: healthy -> no detection', () => {
  assert.equal(detectRemediationTool('back_sync', pipe('back_sync', { detail: { missed_count: 0 } })), null);
});

// --- shopify_webhook: subscription removal ---------------------------------
test('shopify_webhook: a removed subscription -> webhook_resubscribe', () => {
  const d = detectRemediationTool(
    'shopify_webhook',
    pipe('shopify_webhook', { detail: { missing_subscription_count: 1 } }),
  );
  assert.equal(d?.toolId, 'webhook_resubscribe');
});

// --- Subjects with a single tool have no runtime distinction ----------------
test('price_sync / nav_job_queue / allocator: detection returns null (static primary stands)', () => {
  for (const key of ['price_sync', 'nav_job_queue', 'allocator']) {
    assert.equal(detectRemediationTool(key, pipe(key, { liveness_verdict: 'red' })), null, key);
  }
});

// --- null pipe (no runtime detail) falls back --------------------------------
test('detection returns null when no pipe detail is available', () => {
  assert.equal(detectRemediationTool('inventory_sync', null), null);
});

// --- Every detected toolId resolves to a registered tool --------------------
test('every failure-mode-detected toolId is a registered tool', () => {
  const cases: Array<[string, Partial<PipelineHealth>]> = [
    ['inventory_sync', { liveness_verdict: 'red' }],
    ['inventory_sync', { freshness_verdict: 'red' }],
    ['inventory_sync', { detail: { divergence: { divergence_verdict: 'amber' } } }],
    ['back_sync', { detail: { missed_count: 5 } }],
    ['back_sync', { detail: { missed_count: 1 } }],
    ['back_sync', { detail: { missed_count: 0 }, liveness_verdict: 'red' }],
    ['shopify_webhook', { detail: { missing_subscription_count: 2 } }],
  ];
  for (const [key, over] of cases) {
    const d = detectRemediationTool(key, pipe(key, over));
    assert.ok(d !== null, `${key} should detect`);
    assert.ok(getRemediationTool(d.toolId) !== null, `detected ${d.toolId} must be registered`);
  }
});

// --- The registry helper: detected tool, else static primary ----------------
test('recommendedToolForSubject returns the DETECTED tool when detection fires', () => {
  const { tool, detection } = recommendedToolForSubject(
    'back_sync',
    pipe('back_sync', { detail: { missed_count: 1 } }),
  );
  assert.equal(tool?.id, 'submit_fulfillment_request');
  assert.equal(detection?.toolId, 'submit_fulfillment_request');
  assert.ok((detection?.reason ?? '').length > 0);
});

test('recommendedToolForSubject falls back to the static primary when detection is null', () => {
  // Healthy back_sync -> no detection -> the static primary (recovery_sweep).
  const { tool, detection } = recommendedToolForSubject(
    'back_sync',
    pipe('back_sync', { detail: { missed_count: 0 } }),
  );
  assert.equal(detection, null);
  assert.equal(tool?.id, 'recovery_sweep');
});

test('recommendedToolForSubject with a null pipe uses the static primary', () => {
  const { tool, detection } = recommendedToolForSubject('inventory_sync', null);
  assert.equal(detection, null);
  assert.equal(tool?.id, 'atomic_watcher_restart');
});

// --- Every detection target is a VISIBLE mapping for its subject -------------
// (so the modal has a card to mark "Recommended").
test('every detected toolId is also a mapping under its subject', () => {
  const check: Array<[string, string]> = [
    ['inventory_sync', 'atomic_watcher_restart'],
    ['inventory_sync', 'clear_cu50007_job'],
    ['inventory_sync', 'reconcile_audit'],
    ['back_sync', 'recovery_sweep'],
    ['back_sync', 'submit_fulfillment_request'],
    ['back_sync', 'back_sync_run_now'],
    ['shopify_webhook', 'webhook_resubscribe'],
  ];
  for (const [subjectKey, toolId] of check) {
    const found = REMEDIATION_MAPPINGS.some((m) => m.subjectKey === subjectKey && m.toolId === toolId);
    assert.ok(found, `${subjectKey} must map ${toolId} as a visible card`);
  }
});
