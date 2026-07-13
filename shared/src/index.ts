// Shared contract types for the Order Health service.
//
// These are the single source of truth for the channel dimension, the
// RED / AMBER / GREEN verdict, and the as_of envelope that every health
// response carries. Backend (aggregator + read API) and frontend both import
// from here so the types are never re-declared across the language boundary.

// --- Channel dimension (first-class everywhere) ---------------------------
// DTC is Shopify-originated and correlates on WebId. Wholesale is NAV-originated
// with no Shopify leg to grade, so it must never be flagged as an orphan.
export type Channel = 'dtc' | 'wholesale';

// The channel filter control on the UI adds an 'all' pseudo-value; it is not a
// stored channel, so it lives in its own type.
export type ChannelFilter = Channel | 'all';

// --- Verdict --------------------------------------------------------------
// 'unknown' covers a stage/pipe not yet evaluated (for example before a source
// is provisioned by DevOps). The worst verdict wins in any rollup.
export type Verdict = 'green' | 'amber' | 'red' | 'unknown';

// A non-verdict DISPLAY state (ADR-0008) for a pipe that is correctly not
// reporting, kept in the pipe's detail bag rather than in the Verdict union.
//   active          - normal; the default when the field is absent.
//   disabled        - the feature is deliberately off (e.g. price_sync disabled).
//   idle_no_traffic - healthy and correctly configured but no work / traffic to
//                     report in the window (a quiet webhook topic, an idle stretch).
// The rollup treats disabled / idle_no_traffic as NEUTRAL: not unknown, not
// red/amber, and it does not drag the leadership headline off healthy.
export type PipeApplicability = 'active' | 'disabled' | 'idle_no_traffic';

// Verdict ordering for "worst wins" rollups. Higher is worse.
const VERDICT_SEVERITY: Record<Verdict, number> = {
  green: 0,
  unknown: 1,
  amber: 2,
  red: 3,
};

// Roll a set of sub-verdicts up to the worst one. Empty set is 'unknown'.
// Seeded with 'green' (the best) so an all-green rollup is green; 'unknown' is
// worse than green (severity table) and still wins when a sub-verdict is unknown.
export function worstVerdict(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.length === 0) return 'unknown';
  let worst: Verdict = 'green';
  for (const v of verdicts) {
    if (VERDICT_SEVERITY[v] > VERDICT_SEVERITY[worst]) {
      worst = v;
    }
  }
  return worst;
}

// --- Lifecycle stages -----------------------------------------------------
export type LifecycleStage =
  | 'shopify_order'
  | 'allocator_split'
  | 'nav_staging'
  | 'nav_promotion'
  | 'awaiting_ship'
  | 'nav_shipment'
  | 'back_sync'
  | 'complete';

// --- as_of envelope -------------------------------------------------------
// Every health API response is wrapped so the snapshot materialization time is
// always present. Freshness is thus self-disclosing (ADR-0002).
export interface HealthEnvelope<T> {
  as_of: string; // ISO-8601 snapshot materialization time
  data: T;
}

export function envelope<T>(as_of: string, data: T): HealthEnvelope<T> {
  return { as_of, data };
}

// --- Read-model row shapes (mirror db/migrations/0001_init.sql) ------------
export interface OrderHealth {
  channel: Channel;
  nav_order_no: string | null;
  shopify_order_id: string | null;
  shopify_order_name: string | null;
  customer_ref: string | null;
  current_stage: LifecycleStage;
  order_verdict: Verdict;
  oldest_stuck_age_s: number | null;
  is_orphan_suspect: boolean;
  note: string | null;
}

// The three-verdict inventory-sync contract (design.md 5A.2), generalized so
// any pipe can carry freshness + liveness sub-verdicts plus a typed detail bag.
export interface PipelineHealth {
  pipe: string;
  pipe_verdict: Verdict;
  freshness_verdict: Verdict;
  watermark_lag_s: number | null;
  last_progress_at: string | null;
  liveness_verdict: Verdict;
  heartbeat_at: string | null;
  heartbeat_age_s: number | null;
  detail: Record<string, unknown>;
}

// --- Inventory-sync pipe detail (design.md 5A.2) --------------------------
// The inventory-sync pipe carries a typed detail bag inside PipelineHealth.detail
// (which is a loose Record on the wire). Backend writes this shape; the frontend
// panel casts detail to InventorySyncDetail to render the third (push-outcome)
// verdict, the recent-walks bar chart, and the walks table. Snake_case matches
// the JSONB column convention.
export interface InventoryWalk {
  walk_at: string | null;     // ISO time the catalog walk completed
  processed: number;          // variant-location pairs examined
  pushed: number;             // pairs pushed to Shopify this walk
  skipped: number;            // pairs unchanged / skipped
  untracked_filtered: number; // pairs dropped for "track quantity off" (onboarding signal)
}

export interface InventoryDivergence {
  dryrun_would_push: number | null;  // last dry-run "would push" count
  dryrun_at: string | null;          // when that dry-run ran
  total_pairs: number | null;        // denominator ("of 12,218")
  live_push_trailing: number | null; // trailing MAX pushed across recent live walks
  ratio: number | null;              // dryrun_would_push / max(live_push_trailing, 1)
  // AMBER-capped, never RED (design.md 5A.3). A large divergence caps at amber.
  divergence_verdict: Verdict;
}

// The full typed detail bag for the inventory_sync pipe.
export interface InventorySyncDetail {
  trigger_mode: 'job_queue';
  watermark_entry_no: number | null;
  nav_newest_iabc_entry_no: number | null;
  watermark_entry_gap: number | null; // newest IABC entry minus watermark entry
  last_walk: InventoryWalk | null;
  recent_walks: InventoryWalk[];      // most-recent-first
  divergence: InventoryDivergence;
}

// --- Allocator (Warehouse Split) pipe detail (Unit 4, design.md 3.2 / 5) ------
// The allocator pipe grades the warehouse-splitter's split decisions
// (warehouse_allocation_log). Like inventory_sync it carries freshness +
// liveness in PipelineHealth columns and a typed detail bag here: the recent
// split decisions (Mari's 4 rules) and the split-sanity signal (rate of
// un-allocatable / failed splits). Snake_case matches the JSONB convention.
export type AllocationOutcome = 'allocated' | 'split' | 'unallocatable' | 'failed';

export interface AllocationDecision {
  decided_at: string | null;      // ISO time the split decision was logged
  order_ref: string | null;       // Shopify order name or NAV order no
  channel: Channel | null;        // dtc / wholesale (null when not resolved)
  sku: string | null;             // variant / item allocated
  qty: number | null;             // units on the line
  rule: string | null;            // rule applied ("least-split -> TAC", etc.)
  location: string | null;        // resolved warehouse (TAC / OLD / NEW / HF1FTZ)
  outcome: AllocationOutcome;      // allocated | split | unallocatable | failed
}

export interface AllocatorSplitSanity {
  decisions_window: number | null;    // total decisions counted in the window
  split_count: number | null;         // multi-warehouse splits
  split_rate: number | null;          // split_count / decisions_window
  unallocatable_count: number | null; // decisions IN THE WINDOW with no ATP anywhere
  failed_count: number | null;        // errored decisions IN THE WINDOW
  failed_rate: number | null;         // (unallocatable + failed within window) / decisions_window
  atp_fallback_count: number | null;  // inventory-aware fallbacks
  // green/amber/red by failed_rate bands. Unlike inventory divergence this is
  // NOT amber-capped: a genuinely high un-allocatable rate is allowed to go RED.
  sanity_verdict: Verdict;
  // Unit 4 (health-fidelity): the STANDING OOS-held / needs-operator backlog,
  // surfaced as its own labelled count and age. This is a separate population from
  // the in-window failed decisions above: an order held for lack of stock over
  // days is NOT a recent allocation failure, so it must NOT inflate failed_rate.
  // Kept out of the sanity band; it drives its own informational chip, not the verdict.
  oos_held_count?: number | null;         // orders currently held out-of-stock / needs-operator / backorder
  oos_held_oldest_age_s?: number | null;  // age of the oldest such held order (first-seen)
}

export interface AllocatorDetail {
  window_seconds: number | null;      // the window the counts cover
  last_decision_at: string | null;    // recency driver for freshness
  recent_decisions: AllocationDecision[]; // most-recent-first
  sanity: AllocatorSplitSanity;
}

// --- Unit 3 pipe detail bags (job-queue, price-sync, Shopify webhooks) -----
// Each pipe carries its own typed detail bag inside PipelineHealth.detail. The
// backend writes the shape; the panel casts detail to it. Snake_case matches
// the JSONB column convention.

// nav_job_queue (Unit 1, ADR-0007): this pipe now COMPUTES its verdict from
// read-only NAV (last CU 50009 auto-release recency, a genuinely stuck in-process
// CU 50007, and real Status=0 pending-promotion staging rows). The middleware's
// own level and stuck-staging count are kept as a LABELLED CROSS-CHECK, not the
// verdict. New NAV fields are optional so snapshots/tests that predate the compute
// still type-check.
export interface JobQueueDetail {
  source: 'nav:job-queue-log+staging' | 'middleware:job-queue/health';
  // The three independent NAV-computed sub-verdicts.
  liveness_verdict?: Verdict;   // recency of the last CU 50009 auto-release firing
  stuck_job_verdict?: Verdict;  // a genuinely stuck in-process CU 50007 (>= ~60 min)
  staging_verdict?: Verdict;    // real Status=0 pending-promotion staging backlog
  auto_release_fired_at: string | null;   // last CU 50009 auto-release firing (NAV)
  auto_release_age_s: number | null;       // wall-clock age of that firing
  longest_running_job_s: number | null;    // oldest IN-PROCESS CU 50007 age (NAV)
  in_process_job_count?: number | null;     // CU 50007 rows currently in process (NAV)
  pending_staging_count?: number | null;    // real Status=0 rows pending promotion (NAV)
  // Middleware cross-check (monitored, NOT authoritative for the verdict).
  middleware_verdict_raw: string | null;          // the raw level the endpoint returned
  middleware_stuck_staging_count?: number | null; // the endpoint's own count (for divergence)
  stuck_job_count: number | null;                 // jobs the middleware flags stuck
  checked_at: string | null;                      // when the middleware computed its view
  // Legacy: the verdict this pipe adopted before Unit 1 (kept for old snapshots).
  adopted_verdict?: Verdict;
}

// price_sync: freshness (last price-sync signal received) + liveness (last
// price-sync run/loop), both cycle-banded like inventory-sync.
export interface PriceSyncDetail {
  last_received_at: string | null;    // last price-sync signal received (freshness)
  last_received_age_s: number | null;
  last_run_at: string | null;         // last price-sync run/loop completed (liveness)
  last_run_age_s: number | null;
  // ADR-0008 applicability. 'disabled' when the middleware reports the feature off
  // (all timestamps null AND an explicit disabled signal): a disabled feature reads
  // as a labelled neutral state, not a broken-sensor 'unknown'. Absent => 'active'.
  applicability?: PipeApplicability;
}

// shopify_webhook: last-received per topic plus the subscription-removal signal
// (a removed/absent subscription is the WAF-removal failure mode, amber-or-worse).
export interface WebhookTopicHealth {
  topic: string;
  last_received_at: string | null;
  last_received_age_s: number | null;
  subscribed: boolean;            // false = removed/absent subscription (amber-or-worse)
  verdict: Verdict;               // per-topic freshness verdict (subscription folds into the pipe)
  // Subscribed but no receipt in the window: quiet, not broken (ADR-0008). A quiet
  // topic contributes a neutral state, not an 'unknown', to the pipe rollup.
  idle_no_traffic?: boolean;
}

export interface ShopifyWebhookDetail {
  topics: WebhookTopicHealth[];
  missing_subscription_count: number; // topics with subscribed === false
  freshest_received_at: string | null;
  stalest_received_at: string | null;
  // ADR-0008 applicability. 'idle_no_traffic' when every subscribed topic is
  // simply quiet (no receipt in the window) and no subscription is missing: the
  // pipe reads a labelled neutral state rather than being dragged to 'unknown' by
  // a quiet topic. A genuinely missing subscription is still amber-or-worse and
  // keeps applicability 'active'. Absent => 'active'.
  applicability?: PipeApplicability;
  idle_topic_count?: number;          // subscribed topics with no receipt in the window
}

// --- Back-sync pipe detail (Unit 2, design.md 3.2 / 5 line "Missed back-sync") -
// The back-sync pipe (NAV shipment -> Shopify fulfillmentCreate) carries these in
// PipelineHealth.detail. Backend writes this shape; the BackSyncPanel casts detail
// to BackSyncDetail to render the missed-shipments count and table. Snake_case
// matches the JSONB column convention.
//
// A missed shipment is a NAV shipment (GRUS$Sales Shipment Header) that posted but
// has no shopify_fulfillment_id in the middleware's nav_shipment_sync, i.e. the
// fulfillmentCreate never fired. Wholesale shipments have no Shopify back-sync leg
// (no WebId) and are excluded upstream, so they never count as missed.
export interface MissedShipment {
  order_ref: string | null;        // Shopify order name (SP-319090) or NAV order no
  web_id: string | null;           // Shopify WebId correlation key (wholesale has none)
  nav_shipment_no: string | null;  // GRUS$Sales Shipment Header [No_]
  carrier: string | null;
  tracking: string | null;
  posted_at: string | null;        // NAV shipment posting time (ISO)
  age_s: number | null;            // wall-clock age since posted
  reason: string | null;           // human note (e.g. escalated after 6h)
}

// The full typed detail bag for the back_sync pipe. Unlike inventory-sync's
// divergence (amber-capped), the missed-shipments signal is a real backlog and is
// allowed to reach RED (design.md 5 "Missed back-sync ... RED").
export interface BackSyncDetail {
  last_back_sync_at: string | null;   // watermark: last successful fulfillmentCreate
  missed_verdict: Verdict;            // count-banded; NOT capped, may be RED
  missed_count: number;               // NAV shipments lacking a Shopify fulfillment
  missed_window_days: number;         // lookback window for the count (e.g. 14)
  fulfillments_last_24h: number | null;
  errors_last_24h: number | null;
  missed_shipments: MissedShipment[]; // detail rows for the panel table
  // Unit 2 (health-fidelity): the freshness/liveness clocks are gated on whether
  // there is UNSYNCED work. When NAV shows no DTC shipment posted since the last
  // back-sync record, the watcher is idle-not-behind: the age clocks do not run and
  // the pipe reads a neutral state instead of aging to amber during a quiet stretch.
  has_unsynced_work?: boolean;             // a NAV DTC shipment newer than the watermark exists
  newest_unsynced_shipment_at?: string | null; // the shipment the watermark is aged against (null when idle)
  applicability?: PipeApplicability;       // 'idle_no_traffic' during a quiet, caught-up stretch
}

export interface HealthTransition {
  subject_kind: 'pipe' | 'signal' | 'order';
  subject_key: string;
  from_verdict: Verdict;
  to_verdict: Verdict;
  opened_at: string;
  resolved_at: string | null;
  note: string | null;
}

// Response payload types the read API returns (inside a HealthEnvelope).
export type PipelinesResponse = HealthEnvelope<PipelineHealth[]>;
export type OrdersResponse = HealthEnvelope<OrderHealth[]>;

// --- Leadership rollup (design.md section 6, Unit 6) -----------------------
// The top-of-page rollup collapses the two-layer model into a small set of
// headline verdicts suitable for a leadership glance, with operator detail below
// the fold. It is derived READ-ONLY from the SAME latest snapshot the pipeline
// and order endpoints serve (no new external source): the pipeline_health rows
// and the order_health rows. Nothing here fans out to a live source.

// The three headline buckets. 'stuck' = something is RED (a red pipe or a
// SLO-breached / immediately-red order); 'at_risk' = something is AMBER but
// nothing is red; 'healthy' = nothing observed is red or amber.
export type RollupHeadline = 'healthy' | 'at_risk' | 'stuck';

// Per-verdict tallies for the at-a-glance counts, one set per layer.
export interface RollupCounts {
  orders_total: number;
  orders_green: number;
  orders_amber: number;
  orders_red: number;
  orders_unknown: number;
  pipes_total: number;
  pipes_green: number;
  pipes_amber: number;
  pipes_red: number;
  pipes_unknown: number;
}

export interface LeadershipRollup {
  headline: RollupHeadline;
  // The headline mapped onto the shared Verdict so the UI can render it with the
  // same shape-encoded VerdictChip (green/amber/red/unknown). 'unknown' is the
  // healthy-empty case: nothing unhealthy observed, but nothing observed yet.
  headline_verdict: Verdict;
  // Age of the oldest STUCK (red) order, in seconds; null when no order is red.
  oldest_stuck_age_s: number | null;
  // The inventory_sync pipe's freshness: true = fresh (green), false = stale
  // (amber/red), null = unknown (no inventory_sync row, or its freshness is
  // unknown / not yet provisioned).
  inventory_sync_fresh: boolean | null;
  counts: RollupCounts;
}

// The rollup endpoint returns the rollup fields flattened alongside as_of. It is
// a single object (not a list), so as_of rides inline rather than in the
// HealthEnvelope.data wrapper; as_of is still always present (firm rule).
export type RollupResponse = { as_of: string } & LeadershipRollup;

// --- Remediation runbook layer (Unit 7, design.md 5A.4 + section 8) --------
// The runbook maps a red signal / pipe to a NAMED, OPERATOR-TRIGGERED tool.
// Every tool either calls an EXISTING authenticated middleware endpoint or points
// at a documented ops runbook. This layer NEVER adds a middleware endpoint, never
// auto-fires, and never makes NAV anything other than read-only.

// How a tool is carried out. 'middleware_endpoint' hits an endpoint the
// middleware ALREADY exposes (for example recovery.rs). 'ops_runbook' is a
// documented ops path (a systemctl restart, a NAV-admin action) with no live
// call from this service.
export type RemediationKind = 'middleware_endpoint' | 'ops_runbook';

// The existing authenticated middleware endpoint a tool invokes. Documented as a
// shape only; the remediationClient is stubbed and never fires a live call.
export interface RemediationEndpoint {
  method: 'POST' | 'GET';
  path: string;   // for example '/api/recovery/fulfillments'
  source: string; // the middleware function, for example 'recovery.rs :: submit_fulfillment_requests_for_order'
}

// A documented ops runbook reference (no live call, no middleware endpoint).
export interface RemediationRunbook {
  ref: string;         // doc path, for example 'ATOMIC_RESTART_DEPLOYMENT.md'
  command?: string;    // the operator command, for example 'systemctl restart grundens-middleware'
  diagnostic?: string; // read-only endpoint used to diagnose first, for example 'GET /api/nav/job-queue/health'
}

// One named remediation tool. Exactly one of endpoint / runbook is populated.
export interface RemediationTool {
  id: string;          // stable key, for example 'recovery_sweep'
  name: string;        // human name surfaced in the modal
  description: string; // what running it does, in plain language
  kind: RemediationKind;
  endpoint?: RemediationEndpoint; // set when kind === 'middleware_endpoint'
  runbook?: RemediationRunbook;   // set when kind === 'ops_runbook'
  writeCapable: boolean; // true = it mutates via an existing ops path; false = read-only / guidance only
}

// Which subject (pipe / order-level signal) a tool applies to, and the red
// condition that surfaces it. subjectKey is a pipe key (for example
// 'inventory_sync') or a named order-level signal (for example 'missed_back_sync').
export interface RemediationMapping {
  subjectKind: HealthTransition['subject_kind'];
  subjectKey: string;
  appliesWhen: string; // human note of the RED condition it addresses
  toolId: string;      // references RemediationTool.id
  primary: boolean;    // the default tool for that subject (first offered in the modal)
}

// The registry the read API serves so the frontend modal can name the mapped tool
// for a red signal without re-declaring the runbook.
export interface RemediationRegistry {
  tools: RemediationTool[];
  mappings: RemediationMapping[];
}
export type RemediationRegistryResponse = { as_of: string } & RemediationRegistry;

// The typed result of an operator trigger. STUBBED: status is always
// 'would_trigger'; no live call is made (middleware auth is DevOps-gated). The
// resolved call shape is echoed so an operator sees exactly what WOULD run.
export interface RemediationTriggerResult {
  status: 'would_trigger';
  as_of: string;
  toolId: string;
  toolName: string;
  kind: RemediationKind;
  // The authenticated call that WOULD be issued (documented, not fired), or the
  // ops runbook step to run by hand.
  wouldCall: string;
  // Human confirmation line, matching the demo's "done" copy.
  message: string;
  // Whether an open health_transition row was resolved as a remediation event.
  resolvedSubject: { subjectKind: HealthTransition['subject_kind']; subjectKey: string } | null;
}
