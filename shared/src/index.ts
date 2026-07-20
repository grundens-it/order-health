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

// --- Shopify reconciliation (ADR-0007 / ADR-0009) -------------------------
// The storefront side of a reconciliation: what the middleware CLAIMS vs what
// Shopify (read-only) actually shows. Attached to a pipe's detail so the panel can
// surface exactly WHERE they diverge (the SKU, the order), not just a colour. It is
// surface-only: the verdict is still driven by NAV / the middleware; a divergence is
// reported, and `available: false` means Shopify was not reached (unknown, never a
// false green).
export interface ShopifyDivergenceItem {
  key: string;                        // the SKU / order / shipment that differs
  nav: string | number | null;       // what NAV / the middleware claims
  shopify: string | number | null;   // what Shopify actually holds
  note: string;                       // human description of the divergence
}
export interface ShopifyReconciliation {
  source: 'shopify-admin';
  available: boolean;                 // false => Shopify not reached (unknown)
  checked: number;                    // items compared
  reconciled: boolean;                // checked > 0 and no divergence
  divergences: ShopifyDivergenceItem[];
}

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
  // Round 3: the FS-aware classification of an awaiting_ship stall, plus a return
  // marker so a Happy Return is never graded as a stall. Optional / additive; the
  // read API serves them from the order snapshot detail column (0002 migration).
  classification?: AwaitingShipClass | null;
  awaiting_ship_detail?: AwaitingShipDetail | null;
}

// Round 3 (Unit 1). Why an awaiting_ship order has not shipped, reconciled between
// the Shopify Fulfillment Service (FS) location and NAV warehouse on-hand.
//   fs_floor_at_zero : FS available < 0 while a NAV warehouse is stocked (> 0). The
//                      Symmetry FS floor-at-zero bug (dominant today). NOT a 3PL delay.
//   backordered      : a line is genuinely warehouse-short / on a future IABC date.
//   genuine_3pl_delay: in stock, FS available >= 0, unshipped past the SLO (real chase).
//   orphan_or_return : no NAV order behind the record.
//   return           : a Happy Return / non-sales record; never an awaiting_ship stall.
export type AwaitingShipClass =
  | 'fs_floor_at_zero'
  | 'backordered'
  | 'genuine_3pl_delay'
  | 'orphan_or_return'
  | 'return';

export interface AwaitingShipDetail {
  classification: AwaitingShipClass;
  age_s: number | null;                 // how long the order has been awaiting shipment
  fs_available: number | null;          // Shopify FS-location available (negative = floor-at-zero)
  nav_warehouse_on_hand: number | null; // NAV warehouse on-hand (> 0 while FS < 0 = the bug)
  sample_sku: string | null;            // a representative SKU driving the classification
  why: string;                          // human "why this is red/amber", for the UI
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
  shopify_reconciliation?: ShopifyReconciliation; // NAV availability vs Shopify inventory levels (ADR-0009)
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

// --- OOS-held backlog signal (WI1 #87) + NAV-conditioned routing (WI3 #89) ----
// The middleware oos_held_order queue (GET /api/oos-held) parks DTC orders whose
// lines the allocator could not satisfy. WI1 promotes this backlog from a buried
// count on the allocator pipe to its OWN graded pipe. WI3 joins each held order to
// NAV and buckets it so the correct remediation is routed (a plain re-drive no-ops
// on most of these). Snake_case matches the JSONB / wire convention.

// The queue row's own class + status columns (GET /api/oos-held row shape).
// class: 'transient' (a momentary allocator miss, the alerting population) vs
// 'backorder' (a genuine warehouse short, legitimate and NEVER a red driver).
export type OosHeldClass = 'transient' | 'backorder';
// status: 'pending' (awaiting a retry), 'resolved' (cleared), 'needs_operator'
// (a human must act; the aging population the age band grades).
export type OosHeldStatus = 'pending' | 'resolved' | 'needs_operator';

// WI3 NAV-join bucket. Which remediation is correct depends ENTIRELY on this:
//   not_in_nav          -> a re-drive works (forward_sync_replay).
//   in_nav_line_missing -> re-drive no-ops (DuplicateSkip); needs a manual NAV
//                          line-add (no middleware endpoint exists for it).
//   in_nav_line_present -> the order reached NAV whole; a STALE hold record to clear.
export type OosHeldNavBucket = 'not_in_nav' | 'in_nav_line_missing' | 'in_nav_line_present';

// One held-order row read from /api/oos-held, optionally enriched with the WI3
// NAV-join bucket and the mapped remediation tool. Enrichment fields are null
// until the join runs so an un-joined snapshot still types cleanly.
export interface OosHeldOrder {
  order_id: string | null;       // Shopify numeric id (string on the wire)
  order_name: string | null;     // e.g. "SP-322348"
  held_class: OosHeldClass | null;   // the wire `class` (renamed; `class` is reserved)
  status: OosHeldStatus | null;
  attempts: number | null;
  first_seen_at: string | null;
  last_attempt_at: string | null;
  last_detail: string | null;    // the last retry outcome, human text
  age_s: number | null;          // wall-clock age since first_seen_at (filled by the grader)
  nav_bucket: OosHeldNavBucket | null;   // WI3 routing bucket (null until joined)
  remediation_tool_id: string | null;   // the tool routed for this bucket (null until joined)
}

// The typed detail bag for the oos_held pipe. held_verdict is depth-and-age banded
// over the ALERTING population (transient rows that are not resolved), with the
// age band driven by the needs_operator rows. backorder-class rows are surfaced
// separately and never move the verdict.
export interface OosHeldDetail {
  held_verdict: Verdict;             // depth/age band over the alerting population
  total_count: number | null;        // all held rows (null = source unread => unknown)
  alerting_count: number | null;     // transient, not-resolved rows (the depth signal)
  needs_operator_count: number | null; // transient + needs_operator (drives the age band)
  backorder_count: number | null;    // legitimate backorder-class rows (never red)
  oldest_age_s: number | null;         // oldest held row of any class (informational)
  oldest_alerting_age_s: number | null; // oldest needs_operator row (the age-band driver)
  // WI3 NAV-join bucket tallies (null until the join runs).
  not_in_nav_count: number | null;
  in_nav_line_missing_count: number | null;
  in_nav_line_present_count: number | null;
  reason_counts: Record<string, number>; // last_detail -> count (the top reasons)
  held_orders: OosHeldOrder[];       // the held rows, bucketed + routed when joined
}

// --- Per-location availability divergence signal (WI2 #88) --------------------
// The 2026-07-17 leading indicator: NAV shows stock at HF1FTZ (Holman) while the
// middleware's fulfillment-service (FS) per-location availability reads 0, so the
// allocator bounces the order and drops the line to OutOfStock. This is its OWN
// signal, SEPARATE from the catalog inventory-sync pipe (which was green the whole
// incident). It surfaces the exact diverging SKUs so an operator sees the cause at
// hour 0, not after 173 orders pile up.
export interface FsLocationDivergenceItem {
  sku: string;
  nav_available: number | null;   // NAV IABC Qty Available at HF1FTZ (> 0 = stocked)
  nav_on_hand: number | null;     // NAV IABC Qty On Hand at HF1FTZ (null when unread)
  earliest_shipment_date: string | null; // NAV IABC Earliest Shipment Date (null when unread)
  fs_available: number | null;    // middleware FS-location availability (<= 0 = the divergence)
  note: string;                   // human "why this diverged"
}

export interface FsLocationDivergenceDetail {
  divergence_verdict: Verdict;    // count-banded (amber then red); the leading signal
  checked: number | null;         // SKUs compared on both sides (null = FS source unread)
  diverged_count: number | null;  // SKUs NAV shows stocked at HF1FTZ but FS reads <= 0
  nav_location: string;           // the NAV location compared (HF1FTZ)
  fs_source: string;              // the middleware read used for the FS side
  fs_source_is_proxy: boolean;    // true when a proxy stands in for a clean per-location read
  items: FsLocationDivergenceItem[]; // the diverging SKUs (bounded for the panel)
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
  shopify_reconciliation?: ShopifyReconciliation; // NAV price vs Shopify price spot-check (ADR-0009)
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
  shopify_reconciliation?: ShopifyReconciliation; // Shopify orders vs NAV arrival (outcome, ADR-0009)
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
  shopify_reconciliation?: ShopifyReconciliation; // NAV shipment vs Shopify fulfillment (ADR-0009)
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

// The existing authenticated middleware endpoint a tool invokes. When the
// executable path is DISARMED (the default, ADR-0010) this is documented as a
// shape only and no live call is made. When ARMED, a middleware_endpoint tool
// fires this exact POST with an Authorization: Bearer header.
export interface RemediationEndpoint {
  method: 'POST' | 'GET';
  path: string;   // for example '/api/recovery/fulfillments'
  source: string; // the middleware function, for example 'recovery.rs :: submit_fulfillment_requests_for_order'
  // GATED: the middleware requires its NAV write-gate password (NAV_TOGGLE_PASSWORD)
  // on this endpoint. When true AND armed, the live POST adds the password to the
  // body (never logged). Seed ONLY from documented evidence; where the middleware's
  // per-endpoint auth shape is unconfirmed, leave it unset and confirm before arming.
  gated?: boolean;
  // DRY-RUN SUPPORT: the middleware endpoint accepts a `dry_run` flag and defaults
  // it to true (a safe preview with no write). When set, the modal offers a
  // "Dry run" action (dryRun:true) and a separate red "Run live" action
  // (dryRun:false); the live write stays disabled until a dry run has been
  // previewed. Endpoints without this flag (recovery replay, forward-sync replay,
  // back-sync run-now) have no preview: any confirmed fire is a live action.
  supportsDryRun?: boolean;
  // DESTRUCTIVE: the endpoint deletes / irreversibly mutates data (e.g. the
  // stuck-staging dedupe DELETEs rows). Destructive endpoints get the loud red
  // typed-confirm treatment and, when there is no rollback story, are also
  // heldFromLivePath so they never fire one-click.
  destructive?: boolean;
  // HELD OUT of the Tier 1 live path even when armed + confirmed (ADR-0010): a
  // destructive / irreversible action with no clear rollback story. It always
  // returns 'would_trigger'; the live POST is never issued. heldReason explains why.
  heldFromLivePath?: boolean;
  heldReason?: string;
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
  // Optional numbered runbook steps rendered in the modal (from the runbook draft).
  // Additive and backward compatible: tools without steps render as before.
  steps?: string[];
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

// The body an operator sends to POST /api/remediation/:tool/trigger. `confirmed`
// is the per-action operator sign-off (ADR-0010): the live path fires ONLY when
// confirmed is true. Absent / false returns the 'would_trigger' preview, so a stray
// POST can never fire a mutation. subjectKind/subjectKey name the health subject to
// resolve, if any.
export interface RemediationTriggerInput {
  subjectKind?: HealthTransition['subject_kind'];
  subjectKey?: string;
  confirmed?: boolean;
  // Executable remediation (Tier 1): when the tool is a middleware_endpoint that
  // supports it, dryRun true previews with no write (the middleware defaults to a
  // dry run); dryRun false is the live apply. Omitted keeps the safe server default.
  dryRun?: boolean;
}

// The typed result of an operator trigger.
//   'would_trigger' - DISARMED (or unconfirmed, kill-switched, ops_runbook, or a
//                     held-out action): the exact call is echoed, NO live call made.
//   'triggered'     - ARMED + confirmed: the authenticated middleware POST fired
//                     and returned 2xx. `live` is true.
//   'error'         - ARMED + confirmed but the live POST failed (non-2xx / network
//                     / timeout). Typed, never thrown to the route. `error` carries
//                     the reason; `httpStatus` the response code when there was one.
// The resolved call shape is always echoed so an operator sees exactly what ran or
// would run.
export interface RemediationTriggerResult {
  status: 'would_trigger' | 'triggered' | 'error';
  as_of: string;
  toolId: string;
  toolName: string;
  kind: RemediationKind;
  // The authenticated call that was issued, WOULD be issued (documented, not fired),
  // or the ops runbook step to run by hand.
  wouldCall: string;
  // Human confirmation line.
  message: string;
  // Whether an open health_transition row was resolved as a remediation event.
  resolvedSubject: { subjectKind: HealthTransition['subject_kind']; subjectKey: string } | null;
  // True only when a live HTTP call was actually made (status 'triggered' or a
  // live-attempt 'error'). False for every disarmed / preview outcome.
  live: boolean;
  httpStatus?: number; // the middleware response code, when a live call got one
  error?: string;      // failure reason on status 'error' (no secrets)
}

// One append-only audit-log entry: recorded on EVERY operator execution (armed or
// disarmed), the accountability artifact ADR-0010 requires. params holds the
// non-secret call parameters only; the NAV toggle password and the bearer token
// are NEVER recorded here.
export interface RemediationAuditEntry {
  at: string;          // ISO timestamp of the operator action
  actor: string;       // the authenticated principal name (issue #96); never a secret
  toolId: string;
  subjectKind: HealthTransition['subject_kind'] | null;
  subjectKey: string | null;
  params: Record<string, unknown>; // non-secret call params (method, path, gated, confirmed, ...)
  outcome: RemediationTriggerResult['status']; // would_trigger | triggered | error
}

// --- Failure-mode tool detection (issue #35) -------------------------------
// A pipe can have SEVERAL real remediation tools, and the right one depends on
// the runtime failure mode actually observed, not on a static primary. This PURE
// function inspects a pipe's OBSERVED health (its verdict columns + its typed
// detail bag, both already computed by the pipe compute modules) and NAMES the
// tool whose real middleware contract matches that failure mode.
//
// BOUNDARY: it only NAMES a tool. It fires nothing, adds no endpoint, and reads
// NAV nothing but read-only. The remediation modal marks the detected tool
// "Recommended" (with `reason`) and lists the rest as alternatives; when this
// returns null (no runtime detail, or no distinguishing signal) the caller falls
// back to the static primary mapping. It lives here, beside worstVerdict, so both
// the backend registry and the frontend modal share ONE implementation.
export interface RemediationDetection {
  toolId: string; // the detected tool's id (references RemediationTool.id)
  reason: string; // short human note on the observed failure mode
}

function isRedOrAmber(v: Verdict): boolean {
  return v === 'red' || v === 'amber';
}

// inventory_sync: liveness-dead vs watermark-stale-but-alive vs dry-run-divergence
// (design.md 5A), mapping to atomic restart / clear-the-hung-job / reconcile audit.
function detectInventorySync(pipe: PipelineHealth): RemediationDetection | null {
  // 1. Watcher liveness dead/degraded -> atomic restart (re-attach to the queue).
  if (isRedOrAmber(pipe.liveness_verdict)) {
    return {
      toolId: 'atomic_watcher_restart',
      reason: `watcher liveness ${pipe.liveness_verdict} (heartbeat aging/dead)`,
    };
  }
  // 2. Watermark stale while the watcher is still alive -> the NAV job queue is
  //    serialized behind a hung CU 50007; clear that job so auto-release resumes.
  if (isRedOrAmber(pipe.freshness_verdict)) {
    return {
      toolId: 'clear_cu50007_job',
      reason: `watermark stale (freshness ${pipe.freshness_verdict}) but watcher alive`,
    };
  }
  // 3. Dry-run divergence (structurally amber-capped) -> read-only reconcile audit.
  const divergence = (pipe.detail as unknown as InventorySyncDetail).divergence;
  if (divergence !== undefined && divergence.divergence_verdict === 'amber') {
    return {
      toolId: 'reconcile_audit',
      reason: 'dry-run divergence (amber) - classify the delta, do not push',
    };
  }
  return null;
}

// back_sync: backlog -> batch replay; a single miss -> single submit; a stale
// watcher with no backlog -> force a pass (run-now). rescan-from / close-fos are
// visible alternatives with no distinguishing runtime signal.
function detectBackSync(pipe: PipelineHealth): RemediationDetection | null {
  const missed = (pipe.detail as unknown as BackSyncDetail).missed_count ?? 0;
  // A real backlog of unsubmitted fulfillments -> the BATCH replay (<=200 orders).
  if (missed >= 2) {
    return {
      toolId: 'recovery_sweep',
      reason: `${missed} missed shipments - batch replay of unsubmitted fulfillment requests`,
    };
  }
  // Exactly one missed order -> the single-order submit variant.
  if (missed === 1) {
    return {
      toolId: 'submit_fulfillment_request',
      reason: 'one missed shipment - single-order fulfillment submit',
    };
  }
  // No backlog, but the watcher/freshness is stale -> force a back-sync pass.
  if (isRedOrAmber(pipe.liveness_verdict) || isRedOrAmber(pipe.freshness_verdict)) {
    return {
      toolId: 'back_sync_run_now',
      reason: 'no backlog but back-sync watcher stale - force a pass',
    };
  }
  return null;
}

// shopify_webhook: a removed/absent subscription is the WAF-removal failure mode.
function detectShopifyWebhook(pipe: PipelineHealth): RemediationDetection | null {
  const missing = (pipe.detail as unknown as ShopifyWebhookDetail).missing_subscription_count ?? 0;
  if (missing > 0) {
    return {
      toolId: 'webhook_resubscribe',
      reason: `${missing} webhook subscription(s) removed/absent`,
    };
  }
  return null;
}

// Select the tool matching the observed failure mode, or null to fall back to the
// static primary. `pipe` carries both the verdict columns and the typed detail bag.
export function detectRemediationTool(
  subjectKey: string,
  pipe: PipelineHealth | null,
): RemediationDetection | null {
  if (pipe === null) return null;
  switch (subjectKey) {
    case 'inventory_sync':
      return detectInventorySync(pipe);
    case 'back_sync':
      return detectBackSync(pipe);
    case 'shopify_webhook':
      return detectShopifyWebhook(pipe);
    // price_sync / nav_job_queue / allocator each have a single tool today, so
    // there is no runtime distinction to draw: the static primary stands.
    default:
      return null;
  }
}


// --- RBAC + admin arm/disarm (issues #96 / #97) ---------------------------
// The app runs behind Entra Easy Auth, which injects an X-MS-CLIENT-PRINCIPAL
// header (base64 JSON with a claims array). Roles arrive as 'roles' claims
// carrying the Entra app-role values below. These constants are the SINGLE source
// of truth for the role strings so the backend gate and the frontend admin-panel
// visibility check never re-declare them.
export const APP_ROLES = {
  viewer: 'OrderHealth.Viewer',
  operator: 'OrderHealth.Operator',
  admin: 'OrderHealth.Admin',
} as const;
export type AppRole = (typeof APP_ROLES)[keyof typeof APP_ROLES];

// The authenticated caller, resolved from the Easy Auth header (or the dev
// fallback when the header is absent, i.e. Easy Auth is not in front locally).
export interface Principal {
  name: string;      // preferred_username / name claim, or the dev principal name
  roles: string[];   // the 'roles' claim values (Entra app roles)
}

// The typed 403 body returned when a caller's roles do not satisfy a route's gate.
export interface ForbiddenBody {
  error: string;
  code: 'forbidden';
  requiredRoles: string[];  // any-of these would have been allowed
  principalRoles: string[]; // what the caller actually carried
}

// GET /api/auth/me: the resolved principal, so the frontend can decide whether to
// render the Admin-only panel. Open to any authenticated principal.
export type AuthMeResponse = { as_of: string } & Principal;

// Where a resolved runtime flag came from: an explicit runtime_settings row, or
// the env config default (no row present). Surfaced so the admin panel is honest
// about whether the value is a live override or the seeded default.
export type FlagSource = 'runtime_settings' | 'env_default';

// The resolved remediation arm state (issue #97). remediationLiveEnabled and
// killSwitch each resolve as (runtime_settings row) ELSE (env config default);
// `armed` is the effective posture (live enabled AND not kill-switched).
export interface RemediationArmState {
  remediationLiveEnabled: boolean;
  killSwitch: boolean;
  armed: boolean;                 // remediationLiveEnabled && !killSwitch
  liveEnabledSource: FlagSource;
  killSwitchSource: FlagSource;
  updatedBy: string | null;       // last admin who changed a row (null = env default only)
  updatedAt: string | null;       // ISO time of that change (null = env default only)
}
export type RemediationArmStateResponse = { as_of: string } & RemediationArmState;

// The Admin-only PUT bodies for the two arm/disarm controls.
export interface SetArmedInput { armed: boolean }
export interface SetKillSwitchInput { killed: boolean }
