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
  unallocatable_count: number | null; // decisions with no ATP anywhere
  failed_count: number | null;        // errored decisions
  failed_rate: number | null;         // (unallocatable + failed) / decisions_window
  atp_fallback_count: number | null;  // inventory-aware fallbacks
  // green/amber/red by failed_rate bands. Unlike inventory divergence this is
  // NOT amber-capped: a genuinely high un-allocatable rate is allowed to go RED.
  sanity_verdict: Verdict;
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

// nav_job_queue: this pipe CONSUMES the middleware's already-computed job-queue
// health verdict (design.md 6) and does NOT re-derive it. The detail carries the
// middleware's supporting numbers (CU 50009 auto-release recency + stuck-job
// tripwire) purely for context; adopted_verdict is the verdict as surfaced.
export interface JobQueueDetail {
  source: 'middleware:job-queue/health';
  adopted_verdict: Verdict;               // the middleware verdict, surfaced unchanged
  middleware_verdict_raw: string | null;  // the raw verdict string the endpoint returned
  auto_release_fired_at: string | null;   // last CU 50009 auto-release firing
  auto_release_age_s: number | null;      // wall-clock age of that firing
  longest_running_job_s: number | null;   // age of the oldest running Job Queue Entry
  stuck_job_count: number | null;         // jobs the middleware flags stuck (> its own threshold)
  checked_at: string | null;              // when the middleware computed this health
}

// price_sync: freshness (last price-sync signal received) + liveness (last
// price-sync run/loop), both cycle-banded like inventory-sync.
export interface PriceSyncDetail {
  last_received_at: string | null;    // last price-sync signal received (freshness)
  last_received_age_s: number | null;
  last_run_at: string | null;         // last price-sync run/loop completed (liveness)
  last_run_age_s: number | null;
}

// shopify_webhook: last-received per topic plus the subscription-removal signal
// (a removed/absent subscription is the WAF-removal failure mode, amber-or-worse).
export interface WebhookTopicHealth {
  topic: string;
  last_received_at: string | null;
  last_received_age_s: number | null;
  subscribed: boolean;            // false = removed/absent subscription (amber-or-worse)
  verdict: Verdict;               // per-topic freshness verdict (subscription folds into the pipe)
}

export interface ShopifyWebhookDetail {
  topics: WebhookTopicHealth[];
  missing_subscription_count: number; // topics with subscribed === false
  freshest_received_at: string | null;
  stalest_received_at: string | null;
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
