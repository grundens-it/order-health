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
  // Round 3: the dominant nav_staging_stuck case is Not-Auto-released -> rerun_auto_release
  // is primary; the Blocked-SKU and dedupe tools remain mapped alternatives.
  assert.equal(primaryRemediationForSubject('nav_staging_stuck')?.id, 'rerun_auto_release');
  const staging = remediationsForSubject('nav_staging_stuck').map((m) => m.toolId);
  assert.ok(staging.includes('unblock_and_repromote'));
  assert.ok(staging.includes('stuck_staging_dedupe'));
});

test('Round 3: fs_floor_at_zero maps to the FS re-floor, never to a fulfillment tool', () => {
  const tool = primaryRemediationForSubject('fs_floor_at_zero');
  assert.equal(tool?.id, 'fs_refloor');
  assert.equal(tool?.kind, 'ops_runbook'); // an FS re-floor, not a middleware fulfillment call
  const ids = remediationsForSubject('fs_floor_at_zero').map((m) => m.toolId);
  assert.ok(!ids.includes('submit_fulfillment_request'));
  assert.ok(!ids.includes('recovery_sweep'));
});

test('Round 3: shopify_webhook distinguishes a dropped subscription from an outcome gap', () => {
  const ids = remediationsForSubject('shopify_webhook').map((m) => m.toolId);
  assert.ok(ids.includes('webhook_resubscribe')); // subscription removed
  assert.ok(ids.includes('webhook_outcome_redrive')); // intact subscription, orders not arriving
  assert.equal(primaryRemediationForSubject('shopify_webhook')?.id, 'webhook_resubscribe');
});

// --- WI3 (#89): NAV-conditioned OOS-held routing ---------------------------
test('WI3: forward_sync_replay maps ONLY to the not-in-NAV bucket, and is an un-gated middleware endpoint', () => {
  // The tool is offered on not_in_nav and nowhere else (the DuplicateSkip gotcha).
  const subjectsWithReplay = REMEDIATION_MAPPINGS.filter((m) => m.toolId === 'forward_sync_replay').map(
    (m) => m.subjectKey,
  );
  assert.deepEqual(subjectsWithReplay, ['oos_held_not_in_nav']);
  const tool = getRemediationTool('forward_sync_replay');
  assert.equal(tool?.kind, 'middleware_endpoint');
  assert.equal(tool?.endpoint?.path, '/api/forward-sync/replay');
  assert.notEqual(tool?.endpoint?.gated, true); // un-gated per the brief
});

test('WI3: the in-NAV buckets NEVER offer forward_sync_replay (a re-drive would DuplicateSkip)', () => {
  for (const subject of ['oos_held_line_missing', 'oos_held_line_present']) {
    const ids = remediationsForSubject(subject).map((m) => m.toolId);
    assert.ok(!ids.includes('forward_sync_replay'), `${subject} must not offer a re-drive`);
  }
  assert.equal(primaryRemediationForSubject('oos_held_line_missing')?.id, 'oos_held_nav_line_add');
  assert.equal(primaryRemediationForSubject('oos_held_line_missing')?.kind, 'ops_runbook');
  assert.equal(primaryRemediationForSubject('oos_held_line_present')?.id, 'oos_held_stale_clear');
});

test('WI1: the oos_held pipe primary is the per-order triage', () => {
  assert.equal(primaryRemediationForSubject('oos_held')?.id, 'oos_held_triage');
});

// --- Unit 1: recovery-replay FIX wired onto the in-NAV-line-present bucket ----
test('Unit 1: the in-NAV-line-present bucket offers recovery_sweep as a secondary FIX (never a re-drive)', () => {
  const ids = remediationsForSubject('oos_held_line_present').map((m) => m.toolId);
  // The stale-clear ops step stays primary; recovery replay is the secondary FIX.
  assert.equal(primaryRemediationForSubject('oos_held_line_present')?.id, 'oos_held_stale_clear');
  assert.ok(ids.includes('recovery_sweep'), 'line-present offers the recovery replay FIX');
  // A re-drive would DuplicateSkip an in-NAV order, so it must never be offered here.
  assert.ok(!ids.includes('forward_sync_replay'), 'line-present must not offer a re-drive');
  // recovery_sweep is the GATED batch replay (password required, verified in source).
  const recovery = getRemediationTool('recovery_sweep');
  assert.equal(recovery?.endpoint?.path, '/api/recovery/replay-fulfillment-requests');
  assert.equal(recovery?.endpoint?.gated, true);
});

// --- WI2 (#88): FS-location re-floor is a GATED middleware endpoint ---------
test('WI2: fs_location_divergence primary re-floors the FS location, gated by NAV_TOGGLE_PASSWORD', () => {
  const tool = primaryRemediationForSubject('fs_location_divergence');
  assert.equal(tool?.id, 'fs_location_floor');
  assert.equal(tool?.kind, 'middleware_endpoint');
  assert.equal(tool?.endpoint?.path, '/api/nav/inventory-sync/fulfillment-service-floor');
  assert.equal(tool?.endpoint?.gated, true); // password-gated
  // floor-one + sweep are the scoped alternatives.
  const ids = remediationsForSubject('fs_location_divergence').map((m) => m.toolId);
  assert.ok(ids.includes('fs_location_floor_one'));
  assert.ok(ids.includes('fs_location_sweep'));
});
