// No-auto-trigger invariant (Unit 7). Remediation must fire ONLY via the explicit
// operator path, NEVER from the aggregator. We run the full aggregator write path
// (both layers, stubbed sources, no DB) and assert the remediation invocation log
// stays empty; then we exercise the operator path and assert it (and only it)
// records a STUBBED 'would_trigger' with no live call.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runInventoryLayer, runOrderLayer } from '../aggregator/index.js';
import { getRemediationTool } from './registry.js';
import {
  __resetInvocationLogForTest,
  getInvocationLog,
  triggerRemediation,
} from './remediationClient.js';

test('the aggregator write path never invokes remediation', async () => {
  __resetInvocationLogForTest();
  // Full aggregator run for both layers (sources are stubbed; no DB configured).
  await runInventoryLayer();
  await runOrderLayer();
  assert.equal(getInvocationLog().length, 0, 'aggregator must not trigger any remediation');
});

test('only the explicit operator path fires remediation, and it is stubbed (no live call)', () => {
  __resetInvocationLogForTest();
  const tool = getRemediationTool('recovery_sweep');
  assert.ok(tool !== null);

  const before = getInvocationLog().length;
  const result = triggerRemediation(tool, { subjectKind: 'signal', subjectKey: 'missed_back_sync' }, '2026-07-05T18:00:00.000Z');

  // The operator path recorded exactly one invocation, flagged as NOT live.
  assert.equal(getInvocationLog().length, before + 1);
  assert.equal(getInvocationLog()[0]?.live, false);

  // The result is the typed 'would_trigger' stub; no live call was made.
  assert.equal(result.status, 'would_trigger');
  assert.equal(result.toolId, 'recovery_sweep');
  assert.match(result.wouldCall, /\/api\/recovery\/fulfillments/);
  assert.deepEqual(result.resolvedSubject, { subjectKind: 'signal', subjectKey: 'missed_back_sync' });
});
