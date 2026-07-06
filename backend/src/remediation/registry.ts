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
//   - recovery_sweep         (back-sync missed fulfillment)   -> recovery.rs
//   - unblock_and_repromote  (stuck NAV staging)              -> ops runbook (NAV admin)
//   - atomic_watcher_restart (inventory-sync watcher down)    -> ops runbook (systemctl)
//   - clear_cu50007_job      (NAV job queue serialized)       -> ops runbook (NAV admin)
//   - reconcile_audit        (dry-run divergence, read-only)  -> ops runbook (no writes)
// plus two runbook-only entries so every pipe key has a mapping:
//   - webhook_resubscribe    (removed Shopify subscription)   -> ops runbook
//   - allocator_reallocate   (allocator split failures)       -> ops runbook
import type { RemediationMapping, RemediationTool } from '@order-health/shared';
import { PIPES } from '../aggregator/writers';

// --- The named tools ------------------------------------------------------
// Exactly one of endpoint / runbook is populated per tool (asserted in tests).
export const REMEDIATION_TOOLS: readonly RemediationTool[] = [
  {
    id: 'recovery_sweep',
    name: 'Recovery sweep (fulfillmentCreate)',
    description:
      'Re-runs submit_fulfillment_requests_for_order for the order, dispatching the missing Shopify fulfillmentCreate, then re-checks the back-sync watermark.',
    kind: 'middleware_endpoint',
    // The EXISTING authenticated middleware endpoint (recovery.rs). No new path.
    endpoint: {
      method: 'POST',
      path: '/api/recovery/fulfillments',
      source: 'recovery.rs :: submit_fulfillment_requests_for_order -> Shopify fulfillmentCreate',
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
  // back_sync: the pipe red is a missed-fulfillment backlog.
  {
    subjectKind: 'pipe',
    subjectKey: 'back_sync',
    appliesWhen: 'Missed back-sync backlog: NAV shipments posted with no Shopify fulfillmentCreate.',
    toolId: 'recovery_sweep',
    primary: true,
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
  // shopify_webhook: a removed subscription is the WAF-removal failure mode.
  {
    subjectKind: 'pipe',
    subjectKey: 'shopify_webhook',
    appliesWhen: 'A webhook subscription is removed/absent (WAF-removal failure mode) or a topic is stale.',
    toolId: 'webhook_resubscribe',
    primary: true,
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
    subjectKey: 'nav_staging_stuck',
    appliesWhen: 'An order is stuck in NAV staging (CU 50009 errored promoting a Blocked SKU).',
    toolId: 'unblock_and_repromote',
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

// Coverage invariant helper (used by the read API and the tests): every pipe key
// in PIPES has at least one mapping with exactly one primary.
export function everyPipeCovered(): boolean {
  return PIPES.every((pipe) => {
    const primaries = remediationsForSubject(pipe).filter((m) => m.primary);
    return primaries.length === 1;
  });
}
