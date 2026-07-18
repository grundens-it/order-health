// No-auto-trigger invariant (Unit 7). Remediation must fire ONLY via the explicit
// operator path, NEVER from the aggregator. We run the full aggregator write path
// (both layers, stubbed sources, no DB) and assert the remediation audit log stays
// empty; then we exercise the operator path (disarmed by default) and assert it
// (and only it) records a 'would_trigger' with no live call.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runInventoryLayer, runOrderLayer } from '../aggregator/index.js';
import { getRemediationTool } from './registry.js';
import {
  __resetRemediationAuditLogForTest,
  getRemediationAuditLog,
  triggerRemediation,
} from './remediationClient.js';

test('the aggregator write path never invokes remediation', async () => {
  __resetRemediationAuditLogForTest();
  // Full aggregator run for both layers (sources are stubbed; no DB configured).
  await runInventoryLayer();
  await runOrderLayer();
  assert.equal(getRemediationAuditLog().length, 0, 'aggregator must not trigger any remediation');
});

test('only the explicit operator path fires remediation, and it is disarmed by default (no live call)', async () => {
  __resetRemediationAuditLogForTest();
  const tool = getRemediationTool('recovery_sweep');
  assert.ok(tool !== null);

  const before = getRemediationAuditLog().length;
  const result = await triggerRemediation(
    tool,
    { subjectKind: 'signal', subjectKey: 'missed_back_sync' },
    '2026-07-05T18:00:00.000Z',
    { confirmed: true }, // even confirmed, the DISARMED default returns a preview
  );

  // The operator path recorded exactly one audit entry, and it is a preview.
  assert.equal(getRemediationAuditLog().length, before + 1);
  assert.equal(getRemediationAuditLog()[0]?.outcome, 'would_trigger');

  // The result is the typed 'would_trigger' preview; no live call was made.
  assert.equal(result.status, 'would_trigger');
  assert.equal(result.live, false);
  assert.equal(result.toolId, 'recovery_sweep');
  assert.match(result.wouldCall, /\/api\/recovery\/replay-fulfillment-requests/);
  assert.deepEqual(result.resolvedSubject, { subjectKind: 'signal', subjectKey: 'missed_back_sync' });
});
