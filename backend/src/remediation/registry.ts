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
    // GATED: recovery.rs::handle_replay documents `password + set_by`, so the armed
    // live POST adds NAV_TOGGLE_PASSWORD (the only tool with documented evidence of
    // the NAV write-gate; the other middleware_endpoint tools' per-endpoint auth
    // shape is unconfirmed and must be verified before arming - see the PR notes).
    endpoint: {
      method: 'POST',
      path: '/api/recovery/replay-fulfillment-requests',
      source:
        'recovery.rs::handle_replay -> submit_fulfillment_requests_for_order (orders_updated.rs) -> Shopify fulfillmentCreate',
      gated: true,
    },
    writeCapable: true,
    steps: [
      'Triage first: confirm the order reached NAV and its Shopify fulfillmentCreate never fired.',
      'Replay the fulfillment request(s); idempotent, already-submitted orders are reported, never double-fulfilled.',
      'Verify the Shopify fulfillment now exists for each replayed order.',
    ],
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
    steps: [
      'Run the pending-fulfillment diagnosis to confirm exactly one order missed back-sync (not a backlog).',
      'Confirm the order reached NAV and its Shopify fulfillmentCreate never fired.',
      'Submit the single fulfillment request (Admin-only live write; idempotent).',
      'Verify the Shopify fulfillment now exists for the order.',
    ],
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
    steps: [
      'Run the missed-shipments diagnosis to confirm the watcher is alive but a pass is overdue (no standing backlog).',
      'Trigger a back-sync pass now (Admin-only live write; the route takes no body).',
      'Re-run the missed-shipments diagnosis to confirm the count dropped and freshness recovered.',
    ],
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
    steps: [
      'Run the missed-shipments diagnosis to identify the historical window of unfulfilled shipments.',
      'Rescan that bounded window (Admin-only live write) so any still-unfulfilled orders re-submit.',
      'Re-run the missed-shipments diagnosis to confirm the window cleared.',
    ],
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
    steps: [
      'Run a recovery replay FIRST so blocked_by_tag / order_fetch_failed names the specific degenerate FulfillmentOrders.',
      'Confirm each target order is genuinely un-fulfillable (cancelled / duplicated / zero-line), NOT merely awaiting shipment.',
      'Close only those named shopify_order_ids (Admin-only live write). Never a bulk close: closing a live FO cancels a shippable order.',
      'Verify the degenerate FulfillmentOrders are closed and the order can proceed.',
    ],
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
    steps: [
      'Confirm the pattern: Shopify FS-location available < 0 while the NAV warehouse is stocked (on-hand > 0).',
      'Confirm stock with the NAV inventory check for the SKU and location.',
      'Re-floor the FS location for the affected SKU(s) (prefer the native fs-floor tool; dry run then apply).',
      'Verify FS available is no longer negative and the order releases to ship. Do NOT submit a fulfillment or chase a 3PL delay.',
    ],
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
    steps: [
      'Run the stuck-staging diagnosis and confirm the rows are header_status = 1 (Not Auto-released), not a Blocked SKU or a duplicate Source Id.',
      'In NAV, re-run the CU 50009 auto-release codeunit so the staged rows promote (NAV admin action; no middleware endpoint does this).',
      'Re-run the stuck-staging diagnosis to confirm the rows promoted and the order cleared staging.',
    ],
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
    steps: [
      'Confirm the webhook subscription is intact (Shopify admin) so this is an outcome gap, not a dropped subscription; re-subscribing will not help.',
      'Identify the specific Shopify orders present in Shopify with no matching NAV arrival.',
      'Re-drive each missing order through the forward-sync path (per-order re-drive) so it stages in NAV.',
      'Confirm the orders now appear in NAV staging.',
    ],
  },
  {
    id: 'stuck_staging_dedupe',
    name: 'Dedupe duplicate NAV staging rows',
    description:
      'Resolves DUPLICATE NAV staging rows for an order (the distinct failure mode from a Blocked ' +
      'SKU) via the middleware, so CU 50009 auto-release can promote the single remaining row. NAV ' +
      'item data itself stays read-only; the middleware owns the dedupe.',
    kind: 'middleware_endpoint',
    // HELD OUT of the Tier 1 live path (ADR-0010): the dedupe DELETES NAV staging
    // rows and there is no documented rollback (a deleted staging row cannot be
    // restored). It stays disarmed - always 'would_trigger', never a live POST -
    // and is never part of any bulk action, pending a rollback story. Surfaced in
    // the PR. This is a per-order, destructive action; do not arm it here.
    endpoint: {
      method: 'POST',
      path: '/api/nav/stuck-staging/dedupe',
      source: 'main.rs:570 -> stuck-staging dedupe',
      destructive: true,
      heldFromLivePath: true,
      heldReason: 'deletes NAV staging rows with no documented rollback; per ADR-0010 held disarmed pending a rollback story',
    },
    writeCapable: true,
    steps: [
      'Run the duplicate-staging preview (read-only) to see exactly which loser rows a dedupe would delete for the order.',
      'Confirm the duplication is a genuine duplicate Source Id (not a Blocked SKU or a Not-Auto-released row, which have their own tools).',
      'This delete is HELD from the one-click live path (no rollback for a deleted staging row): use the Preview here, then have Symmetry / IT run the dedupe deliberately.',
      'After the dedupe, confirm the survivor row promotes via CU 50009 auto-release.',
    ],
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
      diagnostic: 'GET /api/nav/stuck-staging',
    },
    writeCapable: true,
    steps: [
      'Run the stuck-staging diagnosis to identify the referenced SKU that is blocking promotion.',
      'In NAV, clear the Blocked flag on that item ([GRUS$Item].Blocked = 0) (NAV admin action).',
      'Wait for the next CU 50009 auto-release tick to re-promote the staged order.',
      'Re-run the stuck-staging diagnosis to confirm the order cleared staging.',
    ],
  },
  {
    id: 'order_handoff_recut_940',
    name: 'Re-cut the Holman EDI 940 for this order',
    description:
      'The order is released with stock in NAV but no Lanham EDI 940 ever reached Holman Logistics (trade partner 2538727140), so the 3PL never received it. A middleware re-drive does NOT fix this: the order is already in NAV, so forward-sync/replay returns DuplicateSkip and no-ops. There is no API to force an EDI send, so the 940 is re-cut in NAV.',
    kind: 'ops_runbook',
    runbook: {
      ref: 'runbooks/order-handoff-recut-940.md',
      command:
        'In NAV: confirm the order is Released and has no 940 in E.D.I. Send Document Hdr., then re-release it so the 940 is generated; confirm Document Sent = 1 and that the 997 group ack returns',
      diagnostic: 'GET /api/diagnostics/edi-handoff?orderNo=',
    },
    writeCapable: true,
    steps: [
      'Run the EDI handoff diagnosis to confirm there is genuinely no 940 for this order (no row for trade partner 2538727140, document 940). If a 940 exists and is sent and acknowledged, the order is already in Holman\'s court and nothing is wrong.',
      'Confirm in NAV that the order is Released and still has outstanding lines with stock. If it is Open, it was never released and this is not a handoff failure: check the order holds diagnosis for the owning team instead.',
      'Do NOT re-drive the order through the middleware. It is already in NAV, so forward-sync/replay returns DuplicateSkip and changes nothing.',
      'In NAV, re-release the order (reopen then release) so the Lanham EDI 940 is generated for Holman.',
      'Re-run the EDI handoff diagnosis and confirm Document Sent = 1 with a Sent Date, then that the 997 functional acknowledgment returns. Once acked, the order is in Holman\'s court and is healthy.',
    ],
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
    steps: [
      'Confirm the watcher is dead / not advancing (liveness red: heartbeat aging, watcher down), not merely a stale watermark behind a live watcher.',
      'IT / Symmetry: restart the middleware service on the VM (systemctl restart grundens-middleware).',
      'Confirm the watcher re-attached to the job queue and resumed from its last entry.',
      'Watch inventory-sync freshness / liveness recover on the next snapshot.',
    ],
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
    steps: [
      'Run the NAV job-queue health diagnosis to confirm a CU 50007 Job Queue Entry is hung (long-running / in-process) ahead of CU 50009 auto-release.',
      'In NAV, cancel that stuck CU 50007 Job Queue Entry so the queue de-serializes (NAV admin action; the endpoint is read-only).',
      'Confirm CU 50009 auto-release resumes and the pending staging backlog drains.',
      'Re-run the job-queue health diagnosis to confirm the queue is moving again.',
    ],
  },
  {
    // Correction 2 (default to Run): this WAS a manual step list; it now EXECUTES the
    // reconcile. It runs the inventory-sync/check per-SKU dry run (a read: it returns
    // NAV on-hand, Shopify current on-hand, and would_set) and shows the would-push
    // vs live delta inline. READ-ONLY: check mutates nothing (verified against source,
    // CheckSkuRequest { sku, location_code, channel }), so it routes through the
    // read-only diagnostic proxy, never the armed write path, and offers no live button.
    id: 'reconcile_audit',
    name: 'Reconcile: what would push vs what Shopify holds',
    description:
      'Runs the inventory-sync per-SKU check (a read-only dry run) for a SKU + location and shows ' +
      'the delta inline: NAV on-hand, what Shopify currently holds, and what a push would set. ' +
      'Use it to classify a divergence before deciding to push. It writes nothing.',
    kind: 'middleware_endpoint',
    endpoint: {
      method: 'POST',
      path: '/api/nav/inventory-sync/check',
      source: 'inventory_sync.rs::handle_check_sku (CheckSkuRequest { sku, location_code, channel }) - read-only per-SKU dry run',
      readOnly: true,
      checkPath: '/api/nav/inventory-sync/check',
      params: [
        { name: 'sku', label: 'SKU to reconcile', required: true },
        { name: 'location_code', label: 'Location code', default: 'HF1FTZ', required: true },
        { name: 'channel', label: 'Channel', default: 'DTC', required: true },
      ],
    },
    writeCapable: false,
    steps: [
      'Enter the SKU (and location) to reconcile; the check reads NAV on-hand, Shopify current on-hand, and what a push would set.',
      'Read the delta inline: if Shopify current already equals what would be set, there is nothing to push (benign).',
      'If Shopify is behind what NAV holds, the SKU needs a push; use the per-SKU push / Holman release. This check writes nothing.',
    ],
  },
  {
    // Correction 1: the Holman OOS-held PRIMARY fix. Holman (Tigers) is the DTC 3PL
    // at location code HF1FTZ. NAV holds the true on-hand; the inventory-sync push
    // writes it to Shopify, so a held SKU at Holman goes available 0 -> N and the
    // order releases. The DRY RUN is the read-only inventory-sync/check at HF1FTZ
    // (shows Shopify-0 vs would-set-N); the LIVE write is the per-SKU push (gated).
    // Both bodies verified against source: CheckSkuRequest { sku, location_code,
    // channel } and PushSkuRequest { sku, location_code, channel, password, set_by }.
    id: 'oos_held_inventory_push',
    name: 'Release the held order: push Holman on-hand to Shopify (HF1FTZ)',
    description:
      'The root-cause fix for an OOS-held DTC order: NAV holds true on-hand at Holman (HF1FTZ) but ' +
      'Shopify reads it as 0, so the order is held. Dry run the inventory-sync check for the held ' +
      'SKU at HF1FTZ (channel DTC) to see Shopify-0 vs would-set-N, then push it live so Shopify ' +
      'goes 0 -> N in one call and the order releases. Per-SKU and gated (NAV_TOGGLE_PASSWORD).',
    kind: 'middleware_endpoint',
    endpoint: {
      method: 'POST',
      path: '/api/nav/inventory-sync/push',
      source: 'inventory_sync.rs::handle_push_sku (PushSkuRequest { sku, location_code, channel, password, set_by }) - live per-SKU Shopify push',
      gated: true,
      checkPath: '/api/nav/inventory-sync/check',
      params: [
        { name: 'sku', label: 'Held SKU', source: 'order_sku', required: true },
        { name: 'location_code', label: 'Location code', fixed: 'HF1FTZ', required: true },
        { name: 'channel', label: 'Channel', fixed: 'DTC', required: true },
      ],
    },
    writeCapable: true,
    steps: [
      'Dry run the inventory-sync check for the held SKU at HF1FTZ (channel DTC): confirm Shopify current on-hand is 0 (or behind) while NAV on-hand is positive.',
      'Confirm the SKU is the line holding the order (the awaiting-ship sample SKU, or the SKU on the order).',
      'Push it live (Admin-only, gated): Shopify on-hand for that SKU at HF1FTZ goes 0 -> N in one call.',
      'Verify Shopify now shows the SKU available at Holman and the held order releases to ship.',
    ],
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
    },
    writeCapable: true,
    steps: [
      'Confirm the failure is a REMOVED / absent subscription (not an intact subscription with orders not arriving, which is the outcome-gap tool instead).',
      'Re-register the missing Shopify webhook topic subscription (Shopify admin).',
      'Verify the Cloudflare WAF skip rule for /webhooks/shopify/ is still in place so deliveries are not blocked.',
      'Send / await a test event and confirm the topic is receiving again.',
    ],
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
    },
    writeCapable: true,
    steps: [
      'Read the allocator split-sanity signal to confirm a high un-allocatable / failed split share (not a single stuck order, which uses the per-order re-drive).',
      'IT / Symmetry: restart the warehouse-splitter service so it resumes allocating.',
      'Re-drive the un-allocatable / failed orders from the allocation log through the allocator (per-order re-drive).',
      'Confirm the split-sanity share drops on the next snapshot.',
    ],
  },
  // --- WI3 (#89): NAV-conditioned OOS-held routing tools --------------------
  {
    // ONLY for a not-in-NAV held order. The middleware's orders_updated.rs
    // idempotency rule returns DuplicateSkip when allocations exist AND the order
    // is already in NAV; it only falls through and re-stages when the order is NOT
    // in NAV. So this re-drive is valid EXCLUSIVELY for the not_in_nav bucket, and
    // the registry maps it to nothing else (routeHeldOrder enforces the same).
    id: 'forward_sync_replay',
    name: 'Forward-sync replay (re-drive a not-in-NAV held order)',
    description:
      'Re-drives ONE held Shopify order through the forward-sync path so it re-stages ' +
      'in NAV. Valid ONLY when the order is NOT in NAV: the middleware returns ' +
      'DuplicateSkip (a no-op) for an order already in NAV, so this must never be ' +
      'offered on an in-NAV held order.',
    kind: 'middleware_endpoint',
    endpoint: {
      method: 'POST',
      path: '/api/forward-sync/replay',
      source: 'forward-sync/replay -> orders_updated.rs re-drive (re-stages when the order is NOT in NAV)',
      // Un-gated per the brief: the replay body is { shopify_order_id }, no NAV
      // write-gate password. Real mode, no dry_run: any confirmed fire is a live
      // write (Admin-only at the route).
    },
    writeCapable: true,
    steps: [
      'Confirm the held order is NOT in NAV (a re-drive DuplicateSkips an order already in NAV).',
      'Open the modal from the specific order so its numeric Shopify order id is the subject.',
      'Run the replay (Admin-only, real mode, no dry-run) so the order re-stages in NAV.',
      'Verify the order now appears in NAV staging and clears the OOS hold.',
    ],
  },
  {
    // in_nav_line_missing: a re-drive no-ops (DuplicateSkip); the middleware has no
    // endpoint to add the dropped line, so this is a documented NAV-admin runbook.
    id: 'oos_held_nav_line_add',
    name: 'Add the dropped line to the NAV sales order',
    description:
      'The order reached NAV but its dropped SKU line is MISSING, so a re-drive ' +
      'returns DuplicateSkip and cannot recover it (auto-recovery of partial lines ' +
      'is unsupported). Add the missing line to the NAV sales order by hand, then ' +
      'let the normal promotion + allocation flow ship it.',
    kind: 'ops_runbook',
    runbook: {
      ref: 'runbooks/nav-add-dropped-line.md',
      command: 'Add the dropped SKU line to the NAV sales order (NAV admin); do NOT forward-sync replay (DuplicateSkip)',
      diagnostic: 'GRUS$Sales Header present for the order but the dropped SKU is absent from GRUS$Sales Line',
    },
    writeCapable: true,
    steps: [
      'Check NAV presence to confirm the order reached NAV (Sales Header present) but the dropped SKU line is missing.',
      'Add the missing SKU line to the NAV sales order by hand (NAV admin action; no middleware endpoint adds a partial line).',
      'Do NOT forward-sync replay: a re-drive DuplicateSkips an order already in NAV and cannot recover the line.',
      'Let the normal promotion + allocation flow ship the order, then confirm the OOS hold clears.',
    ],
  },
  {
    // in_nav_line_present: the order reached NAV whole; the hold record is stale.
    id: 'oos_held_stale_clear',
    name: 'Verify and clear the stale OOS-held record',
    description:
      'The order is in NAV WITH the line present, so it staged whole and the ' +
      'oos_held record is stale (the order is no longer actually held). Verify the ' +
      'NAV order is progressing, then clear the stale hold record. Not a re-drive.',
    kind: 'ops_runbook',
    runbook: {
      ref: 'runbooks/oos-held-stale-clear.md',
      command: 'Confirm the NAV order (line present) is progressing, then clear the stale oos_held record',
      diagnostic: 'GRUS$Sales Header + the dropped SKU line both present for the order',
    },
    writeCapable: true,
    steps: [
      'Check NAV presence to confirm the order is in NAV WITH its line present (it staged whole), so the hold record is stale.',
      'Confirm the NAV order is progressing normally (promotion / shipment), not actually held.',
      'Clear the stale oos_held record. This is not a re-drive (a re-drive would DuplicateSkip an in-NAV order).',
      'If the NAV shipment posted but the Shopify fulfillment never fired, use the recovery replay FIX instead of clearing.',
    ],
  },
  {
    // The oos_held PIPE-level primary: the correct action is per-order and depends
    // on each row's NAV-join bucket, so the pipe tool is a triage that routes each
    // held order to its bucketed tool (surfaced per row in the OosHeldDetail).
    id: 'oos_held_triage',
    name: 'Triage the OOS-held backlog by NAV-join bucket',
    description:
      'Route each held order by its NAV-join bucket: not-in-NAV -> forward-sync ' +
      'replay; in-NAV line-missing -> add the dropped NAV line by hand; in-NAV ' +
      'line-present -> clear the stale hold. A blanket re-drive is wrong: it no-ops ' +
      '(DuplicateSkip) on every in-NAV order.',
    kind: 'ops_runbook',
    runbook: {
      ref: 'runbooks/oos-held-triage.md',
      command: 'Work the held backlog per the per-order bucket (re-drive / NAV line-add / stale-clear)',
      diagnostic: 'GET /api/oos-held joined to GRUS$Sales Header + GRUS$Sales Line',
    },
    writeCapable: false,
    steps: [
      'Read the OOS-held backlog by NAV-join bucket (shown in this modal) and check NAV presence per order.',
      'Not in NAV: re-drive it (forward-sync replay FIX, Admin-only) so it re-stages in NAV.',
      'In NAV, line missing: add the dropped NAV line by hand (NAV admin); never re-drive (DuplicateSkip).',
      'In NAV, line present: clear the stale hold, or recovery-replay the fulfillment if the NAV shipment posted but Shopify never fulfilled.',
      'Do NOT run a blanket re-drive across the backlog: it no-ops (DuplicateSkip) on every in-NAV order.',
    ],
  },
  // --- WI2 (#88): FS-location re-floor tools (the divergence root-cause fix) ---
  {
    // The native middleware FS re-floor endpoint (the shipped fs-floor API). Gated
    // by NAV_TOGGLE_PASSWORD; dry_run defaults ON server-side. This resets the FS
    // Shopify location's availability to the warehouse-backed floor, clearing the
    // per-location divergence WI2 detects.
    id: 'fs_location_floor',
    name: 'Re-floor the FS location (fulfillment-service-floor)',
    description:
      'Re-floors the fulfillment-service (FS) Shopify location so its per-location ' +
      'availability matches the warehouse-backed floor, clearing the NAV-stocked-but-' +
      'FS-reads-0 divergence. dry_run defaults ON server-side; run a dry pass first, ' +
      'then the live floor. See the -floor-progress read to watch it complete.',
    kind: 'middleware_endpoint',
    endpoint: {
      method: 'POST',
      path: '/api/nav/inventory-sync/fulfillment-service-floor',
      source: 'inventory-sync fulfillment-service-floor (fs-floor API; dry_run defaults on, password-gated)',
      gated: true,
      supportsDryRun: true,
    },
    writeCapable: true,
    steps: [
      'Confirm the pattern: the FS location shows available < 0 while NAV warehouse on-hand > 0.',
      'Confirm stock with the NAV inventory check for the affected SKU and location.',
      'Dry run the re-floor first (preview, no writes), then run it live to reset the FS floor.',
      'Verify FS available is no longer negative and the order releases; a 200 alone does not prove the write stuck, re-read FS available (watch the floor-progress read).',
    ],
  },
  {
    // Single-SKU / single-order variant of the FS re-floor.
    id: 'fs_location_floor_one',
    name: 'Re-floor one SKU at the FS location (fulfillment-service-floor-one)',
    description:
      'Single-target variant of the FS re-floor: re-floors ONE diverging SKU at the ' +
      'FS location. Use when a single SKU diverged rather than a cluster. dry_run ' +
      'defaults ON; password-gated.',
    kind: 'middleware_endpoint',
    endpoint: {
      method: 'POST',
      path: '/api/nav/inventory-sync/fulfillment-service-floor-one',
      source: 'inventory_sync.rs::handle_fs_floor_one_post (FsFloorOneRequest { sku, dry_run, password, set_by })',
      gated: true,
      supportsDryRun: true,
      // Correction 3: the SKU comes from the ORDER data (the diverging SKU on the
      // order), not from subjectKey. Auto-filled from the subject when present, else
      // prompted in the modal; the fire is disabled until it is set.
      params: [{ name: 'sku', label: 'Diverging SKU', source: 'order_sku', required: true }],
    },
    writeCapable: true,
    steps: [
      'Confirm this is a single-SKU divergence (FS available < 0, NAV on-hand > 0 for that one SKU).',
      'Open the modal from the diverging SKU so its SKU is the subject (floor-one targets that SKU).',
      'Dry run first (preview, no writes), then run it live to re-floor just that SKU.',
      'Verify the SKU FS available is no longer negative and the order releases.',
    ],
  },
  {
    // Full FS sweep: re-floors every diverging SKU at the FS location.
    id: 'fs_location_sweep',
    name: 'Sweep the FS location (fulfillment-service-sweep)',
    description:
      'Sweeps the whole FS location, re-flooring every SKU whose FS availability has ' +
      'diverged from its warehouse-backed floor. The broadest FS re-floor; dry_run ' +
      'defaults ON; password-gated. Use for a widespread divergence.',
    kind: 'middleware_endpoint',
    endpoint: {
      method: 'POST',
      path: '/api/nav/inventory-sync/fulfillment-service-sweep',
      source: 'inventory-sync fulfillment-service-sweep (fs-floor API; dry_run defaults on, days_back scan)',
      gated: true,
      supportsDryRun: true,
    },
    writeCapable: true,
    steps: [
      'Use only for a WIDESPREAD divergence (a full size run or drop diverged), not a single SKU.',
      'Dry run the sweep first (preview, no writes) and review the would-change count.',
      'Run it live to re-floor every diverged SKU; watch the sweep-progress read to completion.',
      'Verify the FS-location divergence signal clears and the held orders release.',
    ],
  },
  {
    // genuine_3pl_delay: a READ-ONLY diagnostics tool. The order is picked and in
    // stock at the 3PL (HF1FTZ / HF1FTZPRE) and unshipped past the SLO. There is NO
    // middleware fix (the fix is physical: the warehouse must ship), so this tool
    // mutates nothing. It drives the diagnostics modal (FO Inspector + NAV inventory
    // check via the read-only proxy routes) and gives the operator the chase.
    id: 'genuine_3pl_delay_chase',
    name: 'Chase the 3PL warehouse (read-only diagnostics)',
    description:
      'The order is picked and in stock at the 3PL (HF1FTZ / HF1FTZPRE) and unshipped past the ' +
      'ship SLO. It is not the FS floor bug and not a backorder: the warehouse simply has not ' +
      'shipped it, and there is no middleware endpoint to force a physical ship. This tool is ' +
      'READ-ONLY: it confirms the fulfillment order is assigned and in stock, then gives the ' +
      'operator what they need to chase HF1FTZ warehouse ops. It never re-floors, re-drives, or ' +
      'adds NAV lines.',
    kind: 'ops_runbook',
    runbook: {
      ref: 'runbooks/genuine-3pl-delay-chase.md',
      command:
        'Chase HF1FTZ warehouse ops to expedite pick/pack/ship for this order and carrier; do NOT re-floor, re-drive, or add NAV lines',
      diagnostic:
        'GET /api/shopify/order/:id/fulfillment-orders (FO Inspector) + POST /api/nav/inventory/check (per-SKU on-hand)',
    },
    writeCapable: false,
    steps: [
      'Confirm the order is at HF1FTZ / HF1FTZPRE with lines in stock (warehouse on-hand > 0 and FS available >= 0). If FS available < 0 it is the FS floor bug: use the FS re-floor instead.',
      'Run the FO Inspector to confirm the fulfillment order is assigned to HF1FTZ and open, not held.',
      'Chase HF1FTZ warehouse ops to expedite pick/pack/ship for this order number and carrier.',
      'Do NOT re-floor, re-drive, or add NAV lines: the order is correct, it just needs to physically ship.',
      'Record the chase (who, when) so a repeat breach escalates.',
    ],
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
    // Correction 2 (default to Run): the FS floor-at-zero fix is now the CALLABLE
    // native fs-floor-one endpoint (a one-click Run, dry-run first), not the manual
    // "trigger the Symmetry re-floor" step. The SKU comes from the order (Correction
    // 3). The manual fs_refloor ops path stays only as a fallback alternative.
    subjectKind: 'signal',
    subjectKey: 'fs_floor_at_zero',
    appliesWhen:
      'An awaiting_ship order is held by the FS floor-at-zero bug: Shopify FS-location available < 0 ' +
      'while the NAV warehouse is stocked. Re-floor the diverging SKU at the FS location (native ' +
      'fulfillment-service-floor-one, dry run then live); do not chase a 3PL delay.',
    toolId: 'fs_location_floor_one',
    primary: true,
  },
  {
    subjectKind: 'signal',
    subjectKey: 'fs_floor_at_zero',
    appliesWhen:
      'Fallback if the native fs-floor is unavailable: trigger the Symmetry event-driven FS re-floor ' +
      '(ADR-0003) by hand. Prefer the one-click floor-one Run above.',
    toolId: 'fs_refloor',
    primary: false,
  },
  // Round 3 (Unit 1/3): a genuine 3PL delay. In stock at HF1FTZ, FS available >= 0,
  // unshipped past the SLO. There is no middleware fix; the modal is READ-ONLY and
  // drives the FO Inspector + NAV inventory-check diagnostics, then chases HF1FTZ.
  {
    subjectKind: 'signal',
    subjectKey: 'genuine_3pl_delay',
    appliesWhen:
      'An awaiting_ship order is picked and in stock at the 3PL (HF1FTZ / HF1FTZPRE), FS available >= 0, ' +
      'unshipped past the ship SLO. Read-only: confirm it is genuinely a 3PL delay (not the FS floor bug), ' +
      'then chase the warehouse. No re-floor, re-drive, or NAV line-add.',
    toolId: 'genuine_3pl_delay_chase',
    primary: true,
  },
  // --- WI1 (#87): the oos_held PIPE. Its correct action is per-order (routed by
  // the NAV-join bucket in the detail), so the pipe primary is the triage tool. ---
  {
    subjectKind: 'pipe',
    subjectKey: 'oos_held',
    appliesWhen:
      'The OOS-held backlog is amber/red (transient + needs_operator depth or age). Triage each held ' +
      'order by its NAV-join bucket; a blanket re-drive no-ops (DuplicateSkip) on every in-NAV order.',
    toolId: 'oos_held_triage',
    primary: true,
  },
  // --- WI3 (#89): the three NAV-join buckets, each routed to the CORRECT tool.
  // forward_sync_replay is mapped ONLY to not-in-NAV (never to an in-NAV bucket). ---
  {
    // Correction 1: the PRIMARY OOS-held fix is the Holman inventory release (push
    // NAV on-hand to Shopify at HF1FTZ), the root cause of the hold. The forward-sync
    // re-drive is demoted to a secondary action below.
    subjectKind: 'signal',
    subjectKey: 'oos_held_not_in_nav',
    appliesWhen:
      'A held DTC order at Holman: NAV has on-hand at HF1FTZ but Shopify reads 0. Dry run the ' +
      'inventory check for the held SKU, then push it live so Shopify goes 0 -> N and the order releases.',
    toolId: 'oos_held_inventory_push',
    primary: true,
  },
  {
    // Demoted to secondary (Correction 1). Still valid ONLY for a not-in-NAV held
    // order (a re-drive DuplicateSkips an in-NAV order), so it maps here and nowhere
    // else (asserted in registry.test.ts).
    subjectKind: 'signal',
    subjectKey: 'oos_held_not_in_nav',
    appliesWhen:
      'Secondary: if the order never reached NAV, re-drive it through forward-sync so it re-stages ' +
      '(valid only for a not-in-NAV order; a re-drive no-ops on an in-NAV order).',
    toolId: 'forward_sync_replay',
    primary: false,
  },
  {
    subjectKind: 'signal',
    subjectKey: 'oos_held_line_missing',
    appliesWhen:
      'A held order is in NAV but the dropped SKU line is MISSING: a re-drive returns DuplicateSkip and ' +
      'no-ops. Add the missing NAV line by hand (no middleware endpoint exists); never forward_sync_replay.',
    toolId: 'oos_held_nav_line_add',
    primary: true,
  },
  {
    subjectKind: 'signal',
    subjectKey: 'oos_held_line_present',
    appliesWhen:
      'A held order is in NAV WITH the line present: it staged whole, so the hold record is stale. Verify ' +
      'and clear it; never forward_sync_replay (it would DuplicateSkip anyway).',
    toolId: 'oos_held_stale_clear',
    primary: true,
  },
  {
    // Unit 1: the recovery-replay FIX for the in-NAV-line-present bucket. When the
    // order reached NAV whole and its NAV shipment posted but the Shopify
    // fulfillmentCreate never fired, a re-drive DuplicateSkips; the recovery BATCH
    // replay (recovery.rs, idempotent, already-submitted reported) dispatches the
    // missing fulfillment instead. Secondary to the stale-clear ops step. Verified
    // body: { shopify_order_ids:[i64], set_by } + NAV_TOGGLE_PASSWORD (gated).
    subjectKind: 'signal',
    subjectKey: 'oos_held_line_present',
    appliesWhen:
      'The held order is in NAV with the line present and its NAV shipment posted, but the Shopify ' +
      'fulfillmentCreate never fired. Batch-replay the fulfillment request to dispatch it (idempotent, ' +
      'already-submitted is reported, never double-fulfilled). Not a re-drive (that would DuplicateSkip).',
    toolId: 'recovery_sweep',
    primary: false,
  },
  // --- WI2 (#88): the fs_location_divergence PIPE. Re-floor the FS location (the
  // native fs-floor API); floor-one / sweep are the scoped alternatives. ---
  {
    subjectKind: 'pipe',
    subjectKey: 'fs_location_divergence',
    appliesWhen:
      'NAV shows stock at HF1FTZ but the FS-location availability reads 0 for one or more SKUs (the ' +
      '2026-07-17 leading indicator). Re-floor the FS location so it matches the warehouse-backed floor.',
    toolId: 'fs_location_floor',
    primary: true,
  },
  {
    subjectKind: 'pipe',
    subjectKey: 'fs_location_divergence',
    appliesWhen: 'A SINGLE SKU diverged: re-floor just that SKU at the FS location.',
    toolId: 'fs_location_floor_one',
    primary: false,
  },
  {
    subjectKind: 'pipe',
    subjectKey: 'fs_location_divergence',
    appliesWhen: 'A WIDESPREAD divergence: sweep the whole FS location, re-flooring every diverged SKU.',
    toolId: 'fs_location_sweep',
    primary: false,
  },
  // order_handoff (the reshaped, defect-based order health). The ONLY red this pipe
  // raises is a FAILED HANDOFF to Holman: released with stock but no EDI 940, or a 940
  // created and never sent. Re-driving the order makes it release and cut its 940.
  // Everything else this pipe reports is owned elsewhere and must NEVER route here:
  // an acked 940 is with Holman (their SLA), holds belong to Finance / Customer
  // Service, the EL- skip is the CU 5790 code defect, and no-stock is a backorder.
  {
    subjectKind: 'pipe',
    subjectKey: 'order_handoff',
    appliesWhen: 'Released with stock but the EDI 940 never reached Holman; re-cut the 940 in NAV.',
    toolId: 'order_handoff_recut_940',
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
