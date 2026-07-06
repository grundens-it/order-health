// Remediation registry coverage tests (Unit 7, design.md 5A.4). Pure data
// assertions: every pipe key maps to a tool, the named runbook set is present,
// and the endpoint/runbook boundary holds. No DB, no live source.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PIPES } from '../aggregator/writers.js';
import {
  REMEDIATION_MAPPINGS,
  REMEDIATION_TOOLS,
  everyPipeCovered,
  getRemediationTool,
  primaryRemediationForSubject,
  remediationsForSubject,
} from './registry.js';

// --- Every pipe key has an entry (the coverage invariant) ------------------
test('every pipe key has exactly one primary remediation mapping', () => {
  for (const pipe of PIPES) {
    const primaries = remediationsForSubject(pipe).filter((m) => m.primary);
    assert.equal(primaries.length, 1, `pipe ${pipe} must have exactly one primary`);
    assert.ok(primaryRemediationForSubject(pipe) !== null, `pipe ${pipe} resolves to a tool`);
  }
});

test('everyPipeCovered() is true', () => {
  assert.equal(everyPipeCovered(), true);
});

// --- The named runbook set from the brief / design 5A.4 --------------------
test('the five named tools from the brief are all registered', () => {
  const named = [
    'recovery_sweep',
    'unblock_and_repromote',
    'atomic_watcher_restart',
    'clear_cu50007_job',
    'reconcile_audit',
  ];
  for (const id of named) {
    assert.ok(getRemediationTool(id) !== null, `named tool ${id} must exist`);
  }
});

test('recovery_sweep calls the EXISTING recovery.rs BATCH replay endpoint (no new endpoint)', () => {
  const tool = getRemediationTool('recovery_sweep');
  assert.ok(tool !== null);
  assert.equal(tool?.kind, 'middleware_endpoint');
  // Real route (main.rs:1042); the old '/api/recovery/fulfillments' does not exist.
  assert.equal(tool?.endpoint?.path, '/api/recovery/replay-fulfillment-requests');
  assert.match(tool?.endpoint?.source ?? '', /recovery\.rs::handle_replay/);
  assert.equal(tool?.writeCapable, true);
  // The corrected contract is a BATCH of shopify_order_ids, capped at 200.
  assert.match(tool?.description ?? '', /batch/i);
  assert.match(tool?.description ?? '', /200/);
});

test('reconcile_audit is read-only (not write-capable)', () => {
  assert.equal(getRemediationTool('reconcile_audit')?.writeCapable, false);
});

// --- The endpoint / runbook boundary ---------------------------------------
test('every tool has EXACTLY one of endpoint / runbook, matching its kind', () => {
  for (const tool of REMEDIATION_TOOLS) {
    const hasEndpoint = tool.endpoint !== undefined;
    const hasRunbook = tool.runbook !== undefined;
    assert.notEqual(hasEndpoint, hasRunbook, `${tool.id} must have exactly one of endpoint/runbook`);
    if (tool.kind === 'middleware_endpoint') assert.ok(hasEndpoint, `${tool.id} endpoint`);
    if (tool.kind === 'ops_runbook') assert.ok(hasRunbook, `${tool.id} runbook`);
  }
});

test('every mapping references a registered tool', () => {
  for (const m of REMEDIATION_MAPPINGS) {
    assert.ok(getRemediationTool(m.toolId) !== null, `mapping ${m.subjectKey} -> ${m.toolId}`);
  }
});

test('order-level signals map to their tools (missed_back_sync, nav_staging_stuck)', () => {
  assert.equal(primaryRemediationForSubject('missed_back_sync')?.id, 'recovery_sweep');
  assert.equal(primaryRemediationForSubject('nav_staging_stuck')?.id, 'unblock_and_repromote');
});
