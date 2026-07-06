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
export function worstVerdict(verdicts: readonly Verdict[]): Verdict {
  let worst: Verdict = 'unknown';
  for (const v of verdicts) {
    if (VERDICT_SEVERITY[v] > VERDICT_SEVERITY[worst]) {
      worst = v;
    }
  }
  return verdicts.length === 0 ? 'unknown' : worst;
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
