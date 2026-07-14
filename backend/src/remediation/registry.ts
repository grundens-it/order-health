// Remediation runbook registry (Unit 7, design.md 5A.4).
//
// BOUNDARY: this is the runbook mapping ONLY. It names, for each red signal /
// pipe, the OPERATOR-TRIGGERED tool that fixes it, and points that tool at EITHER
// an EXISTING authenticated middleware endpoint OR a documented ops runbook. It
// adds NO new middleware endpoint, NO new table, and NO automatic trigger. NAV
// stays read-only. The values here are pure data (no I/O), so the coverage
// invariants are unit-testable without a DB or a live source.
//
// The named runbook set (design.md 5A.4 + the demo's remediation registry):
//   - recovery_sweep         (back-sync missed fulfillment)   -> recovery.rs (BATCH replay)
//   - unblock_and_repromote  (stuck NAV staging)              -> ops runbook (NAV admin)
//   - atomic_watcher_restart (inventory-sync watcher down)    -> ops runbook (systemctl)
//   - clear_cu50007_job      (NAV job queue serialized)       -> ops runbook (NAV admin)
//   - reconcile_audit        (dry-run divergence, read-only)  -> ops runbook (no writes)
// plus two runbook-only entries so every pipe key has a mapping:
//   - webhook_resubscribe    (removed Shopify subscription)   -> ops runbook
//   - allocator_reallocate   (allocator split failures)       -> ops runbook
// and the failure-mode-detection targets (issue #35), each an EXISTING middleware
// endpoint so detection has a real tool to name (never a new endpoint):
//   - submit_fulfillment_request (single missed order)        -> main.rs:1059
//   - back_sync_run_now          (watcher alive, pass due)    -> main.rs:581
//   - back_sync_rescan_from      (historical window)          -> main.rs:594
//   - close_unfulfilled_fos      (degenerate FulfillmentOrders) -> main.rs:841
//   - stuck_staging_dedupe       (duplicate NAV staging rows) -> main.rs:570
import type {
  PipelineHealth,
  RemediationDetection,
  RemediationMapping,
  RemediationTool,
} from '@order-health/shared';
import { detectRemediationTool } from '@order-health/shared';
import { PIPES } from '../aggregator/writers';

// --- The named tools ------------------------------------------------------
// Exactly one of endpoint / runbook is populated per tool (asserted in tests).
export const REMEDIATION_TOOLS: readonly RemediationTool[] = [
  {
    id: 'recovery_sweep',
    name: 'Recovery sweep (batch fulfillmentCreate replay)',
    description:
      'BATCH replay: takes a list of shopify_order_ids (max 200) plus password + set_by ' +
      '(NAV_TOGGLE_PASSWORD) and re-runs submit_fulfillment_requests_for_order for each, ' +
      'dispatching every missing Shopify fulfillmentCreate. Returns a per-order outcome ' +
      '(submitted / already_submitted / blocked_by_tag / failed / order_fetch_failed). ' +
      'Idempotent: already-submitted orders are reported, never double-fulfilled.',
    kind: 'middleware_endpoint',
    // The EXISTING authenticated middleware endpoint (recovery.rs). No new path.
    endpoint: {
      method: 'POST',
      path: '/api/recovery/replay-fulfillment-requests',
      source:
        'recovery.rs::handle_replay -> submit_fulfillment_requests_for_order (orders_updated.rs) -> Shopify fulfillmentCreate',
    },
    writeCapable: true,
  },
  {
    id: 'submit_fulfillment_request',
    name: 'Submit single fulfillment request',
    description:
      'Single-order variant of the replay: submits submit_fulfillment_requests_for_order for ONE ' +
      'shopify_order_id, dispatching its missing Shopify fulfillmentCreate. Use when exactly one ' +
      'order missed back-sync rather than a backlog.',
    kind: 'middleware_endpoint',
    endpoint: {
      method: 'POST',
      path: '/api/middleware/submit-fulfillment-request',
      source:
        'main.rs:1059 -> submit_fulfillment_requests_for_order (orders_updated.rs) -> Shopify fulfillmentCreate',
    },
    writeCapable: true,
  },
  {
    id: 'back_sync_run_now',
    name: 'Back-sync run-now (force a pass)',
    description:
      'Forces the back-sync watcher to run a pass immediately, re-scanning for NAV shipments that ' +
      'still need a Shopify fulfillmentCreate. Use when the watcher is alive but a pass is overdue ' +
      '(freshness stale) with no standing backlog.',
    kind: 'middleware_endpoint',
    endpoint: {
      method: 'POST',
      path: '/api/back-sync/run-now',
      source: 'main.rs:581 -> back-sync pass',
    },
    writeCapable: true,
  },
  {
    id: 'back_sync_rescan_from',
    name: 'Back-sync rescan-from (historical window)',
    description:
      'Re-scans a bounded historical window for missed back-sync shipments and submits any still-' +
      'unfulfilled orders. Use to recover a past window rather than the current tail.',
    kind: 'middleware_endpoint',
    endpoint: {
      method: 'POST',
      path: '/api/back-sync/rescan-from',
      source: 'main.rs:594 -> back-sync rescan',
    },
    writeCapable: true,
  },
  {
    id: 'close_unfulfilled_fos',
    name: 'Close degenerate unfulfilled FulfillmentOrders',
    description:
      'TARGETING + SAFETY (Round 3 review): closes ONLY degenerate Shopify FulfillmentOrders that ' +
      'can never be fulfilled (cancelled / duplicated / zero-line), identified by a prior replay ' +
      'reporting blocked_by_tag / order_fetch_failed for that specific order. It must be scoped to ' +
      'those shopify_order_ids, never a bulk close: closing a LIVE FulfillmentOrder would cancel a ' +
      'shippable order. Use it only after a replay names the stuck FulfillmentOrders, never as a ' +
      'first action, and never against an order that is merely awaiting shipment.',
    kind: 'middleware_endpoint',
    endpoint: {
      method: 'POST',
      path: '/api/order-recovery/close-unfulfilled-fos',
      source: 'main.rs:841 -> close degenerate FulfillmentOrders',
    },
    writeCapable: true,
  },
  {
    // Round 3 (Unit 3): the FS floor-at-zero fix. NOT back_sync / submit_fulfillment:
    // submitting a fulfillment cannot fix a Shopify location floored at a negative
    // available. The fix is the Symmetry event-driven FS re-floor (ADR-0003).
    id: 'fs_refloor',
    name: 'Re-floor the Fulfillment Service location (ADR-0003)',
    description:
      'The Grundens Fulfillment Service (FS) Shopify location is floored at a NEGATIVE available ' +
      'while the NAV warehouse is stocked, so Shopify will not release the order (it looks OOS at ' +
      'FS). Trigger the Symmetry event-driven FS re-floor (ADR-0003) to reset the FS-location ' +
      'available to the warehouse-backed floor for the affected SKU(s), which releases the order. ' +
      'This is NOT a back-sync or a fulfillmentCreate: a fulfillment cannot fix a floored location, ' +
      'and chasing it as a 3PL delay wastes an operator.',
    kind: 'ops_runbook',
    runbook: {
      ref: 'runbooks/fs-refloor.md (ADR-0003)',
      command: 'Trigger the Symmetry event-driven FS re-floor for the affected SKU(s); do NOT submit a fulfillment',
      diagnostic: 'Shopify FS-location available < 0 while NAV warehouse on-hand > 0 (fs_floor_at_zero)',
    },
    writeCapable: true,
  },
  {
    // Round 3 (Unit 3), finding: the nav_staging_stuck "Not Auto-released" gap. The
    // staging rows actually present are header_status = 1 (Not Auto-released), which
    // neither the Blocked-SKU (unblock_and_repromote) nor the duplicate-row
    // (stuck_staging_dedupe) tool addresses. Re-running auto-release promotes them.
    id: 'rerun_auto_release',
    name: 'Re-run CU 50009 auto-release for Not-Auto-released staging rows',
    description:
      'The staging rows are header_status = 1 ("Not Auto-released"): they staged but CU 50009 ' +
      'auto-release never promoted them (the distinct failure mode from a Blocked SKU or a ' +
      'duplicate Source Id). Re-run CU 50009 auto-release so they promote. This closes the gap the ' +
      'Blocked-SKU and dedupe tools leave open.',
    kind: 'ops_runbook',
    runbook: {
      ref: 'runbooks/nav-rerun-auto-release.md',
      command: 'Re-run CU 50009 auto-release (NAV admin) for the Not-Auto-released staging rows',
      diagnostic: 'GET /api/nav/stuck-staging (header_status = 1, Not Auto-released)',
    },
    writeCapable: true,
  },
  {
    // Round 3 (Unit 3), finding: reconcile webhook_resubscribe with the OUTCOME
    // signal. When a subscription is intact but Shopify orders are not arriving in
    // NAV (the outcome reconciliation gap), re-subscribing does nothing; the fix is
    // to re-drive the missing orders through the forward-sync path.
    id: 'webhook_outcome_redrive',
    name: 're-drive orders that did not reach NAV (webhook outcome gap)',
    description:
      'The webhook SUBSCRIPTION is present, yet Shopify orders are not arriving in NAV (the ' +
      'outcome-based signal): a delivery / forward-sync gap, not a dropped subscription. ' +
      'Re-subscribing will NOT help. Re-drive the specific missing orders through the ' +
      'forward-sync path so they stage in NAV.',
    kind: 'ops_runbook',
    runbook: {
      ref: 'runbooks/webhook-outcome-redrive.md',
      command: 'Re-drive the missing Shopify orders through forward-sync (do not re-subscribe an intact subscription)',
      diagnostic: 'Shopify orders present with no matching NAV arrival (subscription intact)',
    },
    writeCapable: true,
  },
  {
    id: 'stuck_staging_dedupe',
    name: 'Dedupe duplicate NAV staging rows',
    description:
      'Resolves DUPLICATE NAV staging rows for an order (the distinct failure mode from a Blocked ' +
      'SKU) via the middleware, so CU 50009 auto-release can promote the single remaining row. NAV ' +
      'item data itself stays read-only; the middleware owns the dedupe.',
    kind: 'middleware_endpoint',
    endpoint: {
      method: 'POST',
      path: '/api/nav/stuck-staging/dedupe',
      source: 'main.rs:570 -> stuck-staging dedupe',
    },
    writeCapable: true,
  },
  {
    id: 'unblock_and_repromote',
    name: 'Unblock item, then re-run promotion sweep',
    description:
      'Diagnose the stuck staging row, clear the Blocked flag on the referenced SKU in NAV, then let CU 50009 auto-release re-promote the staged order on its next tick.',
    kind: 'ops_runbook',
    runbook: {
      ref: 'runbooks/nav-staging-unblock.md',
      command: 'Set [GRUS$Item].Blocked = 0 for the SKU (NAV admin), then wait for CU 50009 auto-release',
      diagnostic: 'GET /api/nav/staging/stuck',
    },
    writeCapable: true,
  },
  {
    id: 'atomic_watcher_restart',
    name: 'Atomic restart of the middleware watcher',
    description:
      'Restarts the middleware watcher; it re-attaches to the job queue and resumes from last_iabc_job_entry_no, recovering inventory-sync freshness.',
    kind: 'ops_runbook',
    runbook: {
      ref: 'ATOMIC_RESTART_DEPLOYMENT.md',
      command: 'systemctl restart grundens-middleware',
    },
    writeCapable: true,
  },
  {
    id: 'clear_cu50007_job',
    name: 'Clear the hung CU 50007 job to de-serialize the queue',
    description:
      'Cancels the stuck CU 50007 Job Queue Entry in NAV so the queue de-serializes and CU 50009 auto-release resumes.',
    kind: 'ops_runbook',
    runbook: {
      ref: 'runbooks/nav-job-queue-clear.md',
      command: 'Cancel the stuck CU 50007 Job Queue Entry (NAV admin)',
      diagnostic: 'GET /api/nav/job-queue/health',
    },
    writeCapable: true,
  },
  {
    id: 'reconcile_audit',
    name: 'Reconcile dry-run vs live accounting',
    description:
      'Read-only investigation: compares the dry-run would-push predicate against the live walk push set and classifies the delta. No writes.',
    kind: 'ops_runbook',
    runbook: {
      ref: 'runbooks/inventory-reconcile-audit.md',
      command: 'Run reconcile_audit (read-only classification of the dry-run vs live delta)',
    },
    writeCapable: false,
  },
  {
    id: 'webhook_resubscribe',
    name: 'Re-subscribe the removed Shopify webhook',
    description:
      'Re-create the missing Shopify webhook subscription and confirm the Cloudflare WAF skip rule for /webhooks/shopify/ is still in place.',
    kind: 'ops_runbook',
    runbook: {
      ref: 'runbooks/shopify-webhook-resubscribe.md',
      command: 'Re-register the webhook subscription (Shopify admin) and verify the WAF skip rule',
      diagnostic: 'GET /api/webhooks/shopify/health',
    },
    writeCapable: true,
  },
  {
    id: 'allocator_reallocate',
    name: 'Restart the allocator and re-run failed splits',
    description:
      'Restart the warehouse-splitter service so it resumes allocating, then re-run the un-allocatable / failed split decisions from the allocation log.',
    kind: 'ops_runbook',
    runbook: {
      ref: 'runbooks/allocator-restart.md',
      command: 'Restart the warehouse-splitter service, then re-run failed allocations',
      diagnostic: 'GET /api/allocator/status',
    },
    writeCapable: true,
  },
] as const;

// --- Subject -> tool mappings ---------------------------------------------
// subjectKey is a pipe key (subjectKind 'pipe') or a named order-level signal
// (subjectKind 'signal'). Every pipe in PIPES has at least one mapping, exactly
// one of which is primary (asserted in tests).
export const REMEDIATION_MAPPINGS: readonly RemediationMapping[] = [
  // inventory_sync: three failure modes, three tools.
  {
    subjectKind: 'pipe',
    subjectKey: 'inventory_sync',
    appliesWhen: 'Watcher liveness RED (heartbeat dead, watcher down with a bb8 timeout).',
    toolId: 'atomic_watcher_restart',
    primary: true,
  },
  {
    subjectKind: 'pipe',
    subjectKey: 'inventory_sync',
    appliesWhen: 'Watermark stale but watcher alive, NAV job queue serialized behind a hung CU 50007.',
    toolId: 'clear_cu50007_job',
    primary: false,
  },
  {
    subjectKind: 'pipe',
    subjectKey: 'inventory_sync',
    appliesWhen: 'Dry-run divergence AMBER (would-push far exceeds live push); classify, do not push.',
    toolId: 'reconcile_audit',
    primary: false,
  },
  // back_sync: several real tools; the right one depends on the runtime failure
  // mode (backlog vs a single miss vs a stale watcher). detectRemediationTool
  // picks the recommended one at open time; these mappings make the alternatives
  // visible in the modal. Exactly one stays primary (the static fallback).
  {
    subjectKind: 'pipe',
    subjectKey: 'back_sync',
    appliesWhen: 'Missed back-sync BACKLOG (>=2): NAV shipments posted with no Shopify fulfillmentCreate.',
    toolId: 'recovery_sweep',
    primary: true,
  },
  {
    subjectKind: 'pipe',
    subjectKey: 'back_sync',
    appliesWhen: 'Exactly ONE missed shipment: a single order to re-submit.',
    toolId: 'submit_fulfillment_request',
    primary: false,
  },
  {
    subjectKind: 'pipe',
    subjectKey: 'back_sync',
    appliesWhen: 'Watcher alive but a back-sync pass is overdue (freshness stale, no standing backlog).',
    toolId: 'back_sync_run_now',
    primary: false,
  },
  {
    subjectKind: 'pipe',
    subjectKey: 'back_sync',
    appliesWhen: 'Recover a bounded historical window of missed shipments.',
    toolId: 'back_sync_rescan_from',
    primary: false,
  },
  {
    subjectKind: 'pipe',
    subjectKey: 'back_sync',
    appliesWhen: 'A replay is blocked by degenerate / unfulfillable FulfillmentOrders.',
    toolId: 'close_unfulfilled_fos',
    primary: false,
  },
  // price_sync: shares the middleware watcher loop; a stalled loop is the watcher.
  {
    subjectKind: 'pipe',
    subjectKey: 'price_sync',
    appliesWhen: 'Price-sync loop stalled (received/run stale); the middleware watcher is not advancing.',
    toolId: 'atomic_watcher_restart',
    primary: true,
  },
  // nav_job_queue: the consumed verdict red means the queue is serialized.
  {
    subjectKind: 'pipe',
    subjectKey: 'nav_job_queue',
    appliesWhen: 'Middleware job-queue verdict RED: CU 50009 auto-release stalled behind a hung job.',
    toolId: 'clear_cu50007_job',
    primary: true,
  },
  // shopify_webhook: reconcile the two distinct failure modes (Round 3 finding).
  // A removed SUBSCRIPTION is the WAF-removal mode -> re-subscribe. An intact
  // subscription with orders not arriving in NAV is an OUTCOME gap -> re-drive, NOT
  // re-subscribe.
  {
    subjectKind: 'pipe',
    subjectKey: 'shopify_webhook',
    appliesWhen: 'A webhook subscription is REMOVED / absent (WAF-removal failure mode).',
    toolId: 'webhook_resubscribe',
    primary: true,
  },
  {
    subjectKind: 'pipe',
    subjectKey: 'shopify_webhook',
    appliesWhen:
      'Subscription intact but Shopify orders are not arriving in NAV (outcome reconciliation gap); ' +
      're-subscribing will not help.',
    toolId: 'webhook_outcome_redrive',
    primary: false,
  },
  // allocator: high un-allocatable / failed split share.
  {
    subjectKind: 'pipe',
    subjectKey: 'allocator',
    appliesWhen: 'Split-sanity RED: high un-allocatable / failed split share on the allocation log.',
    toolId: 'allocator_reallocate',
    primary: true,
  },
  // --- Order-level signals (design.md 5, the demo error rows) ---
  {
    subjectKind: 'signal',
    subjectKey: 'missed_back_sync',
    appliesWhen: 'An order has a NAV shipment with no Shopify fulfillment (missed back-sync).',
    toolId: 'recovery_sweep',
    primary: true,
  },
  {
    subjectKind: 'signal',
    subjectKey: 'missed_back_sync',
    appliesWhen: 'Re-submit just this one order (single-order variant of the replay).',
    toolId: 'submit_fulfillment_request',
    primary: false,
  },
  {
    // Round 3 finding: the DOMINANT real case is "Not Auto-released" (header_status
    // = 1), so it is the primary; the Blocked-SKU and duplicate-row tools remain the
    // alternatives for their distinct failure modes.
    subjectKind: 'signal',
    subjectKey: 'nav_staging_stuck',
    appliesWhen:
      'Not Auto-released (header_status = 1): the row staged but CU 50009 auto-release never ' +
      'promoted it (the gap the Blocked-SKU and dedupe tools do not cover).',
    toolId: 'rerun_auto_release',
    primary: true,
  },
  {
    subjectKind: 'signal',
    subjectKey: 'nav_staging_stuck',
    appliesWhen: 'An order is stuck in NAV staging (CU 50009 errored promoting a Blocked SKU).',
    toolId: 'unblock_and_repromote',
    primary: false,
  },
  {
    subjectKind: 'signal',
    subjectKey: 'nav_staging_stuck',
    appliesWhen: 'DUPLICATE NAV staging rows for the order (the distinct failure mode from a Blocked SKU).',
    toolId: 'stuck_staging_dedupe',
    primary: false,
  },
  // Round 3 (Unit 1/3): an FS floor-at-zero order. Map to the FS re-floor, NEVER to
  // back_sync / submit_fulfillment (a fulfillment cannot fix a floored location).
  {
    subjectKind: 'signal',
    subjectKey: 'fs_floor_at_zero',
    appliesWhen:
      'An awaiting_ship order is held by the FS floor-at-zero bug: Shopify FS-location available < 0 ' +
      'while the NAV warehouse is stocked. Re-floor the FS location (ADR-0003), do not chase a 3PL delay.',
    toolId: 'fs_refloor',
    primary: true,
  },
] as const;

// --- Lookups (pure) --------------------------------------------------------
const TOOLS_BY_ID = new Map(REMEDIATION_TOOLS.map((t) => [t.id, t]));

export function getRemediationTool(id: string): RemediationTool | null {
  return TOOLS_BY_ID.get(id) ?? null;
}

// All mappings for a subject key (pipe or signal), primary first.
export function remediationsForSubject(subjectKey: string): RemediationMapping[] {
  return REMEDIATION_MAPPINGS.filter((m) => m.subjectKey === subjectKey).sort(
    (a, b) => Number(b.primary) - Number(a.primary),
  );
}

// The single primary tool for a subject, or null when none is mapped.
export function primaryRemediationForSubject(subjectKey: string): RemediationTool | null {
  const mapping = remediationsForSubject(subjectKey).find((m) => m.primary);
  return mapping ? getRemediationTool(mapping.toolId) : null;
}

// The RECOMMENDED tool for a subject given its OBSERVED pipe health: the
// failure-mode-detected tool when detection fires (issue #35), else the static
// primary. Pure: detection reads only the already-computed verdicts + detail bag
// on `pipe`, invokes nothing, and adds no endpoint. `pipe` is null for subjects
// with no runtime detail (e.g. order-level signals), which falls back to primary.
export function recommendedToolForSubject(
  subjectKey: string,
  pipe: PipelineHealth | null,
): { tool: RemediationTool | null; detection: RemediationDetection | null } {
  const detection = detectRemediationTool(subjectKey, pipe);
  if (detection !== null) {
    const detected = getRemediationTool(detection.toolId);
    if (detected !== null) return { tool: detected, detection };
  }
  return { tool: primaryRemediationForSubject(subjectKey), detection: null };
}

// Coverage invariant helper (used by the read API and the tests): every pipe key
// in PIPES has at least one mapping with exactly one primary.
export function everyPipeCovered(): boolean {
  return PIPES.every((pipe) => {
    const primaries = remediationsForSubject(pipe).filter((m) => m.primary);
    return primaries.length === 1;
  });
}
