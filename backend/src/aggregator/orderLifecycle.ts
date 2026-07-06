// Order lifecycle grading: the per-order verdict compute (design.md 3.1 / 5).
//
// This is the ORDER-LAYER analogue of the reference pipe compute
// (inventorySync.ts). It is a PURE function of seeded inputs and thresholds (no
// I/O, no clock read beyond the injected nowMs), so every stage boundary and the
// orphan-flag behaviour are unit-testable without a live NAV or middleware
// (design.md section 9, QA seat). writers.ts reads the (read-only, currently
// stubbed) sources, assembles OrderInput rows, and calls computeOrderRows here.
//
// Two channels, first-class (design.md 4):
//   DTC (Shopify-originated): correlates on the Shopify WebId carried on the NAV
//     Sales Header; runs the FULL chain including the Shopify back-sync leg.
//   Wholesale (NAV-originated): keyed on the NAV order number + customer; has NO
//     Shopify leg (no WebId, no back_sync), so it can NEVER be graded an orphan
//     for lacking a WebId.
import type { Channel, ChannelFilter, LifecycleStage, OrderHealth, Verdict } from '@order-health/shared';
import { worstVerdict } from '@order-health/shared';

export interface OrderThresholds {
  // -----------------------------------------------------------------------
  // ORPHAN GRADING GATE (BA open question 1, design.md section 9).
  //
  // "Orphan" (a DTC order that lost its WebId) and "wholesale" (correctly has no
  // WebId) look identical at the row level. Until the BA seat + Mari define what
  // definitively marks a NAV order as wholesale (customer type on GRUS$Customer?
  // an order-source field? a NAV series code?), grading a DTC empty-WebId order
  // as an orphan would produce false REDs on every wholesale order.
  //
  // So orphan grading is OFF by default. When false: is_orphan_suspect is forced
  // false and no orphan verdict is surfaced. When true: a DTC order with an empty
  // WebId is flagged is_orphan_suspect and contributes a RED to its rollup. This
  // flag flips to true only after BA question 1 resolves.
  // -----------------------------------------------------------------------
  orphanGradingEnabled: boolean;

  // Generic in-flight staging/promotion SLO band (design.md 5: "Awaiting
  // promotion: staged but not yet promoted. AMBER under 30 min, RED after").
  stageAmberSeconds: number; // in-flight at a hop beyond this => AMBER
  stageRedSeconds: number;   // in-flight at a hop beyond this => RED

  // Awaiting-ship SLO band (design.md 5: "Awaiting ship: promoted, no NAV
  // shipment. AMBER within channel SLO, RED after"). Kept separate because 3PL
  // shipment latency is measured in hours/days, not minutes.
  awaitingShipAmberSeconds: number;
  awaitingShipRedSeconds: number;
}

// Canonical per-channel chain (design.md 3.1). 'complete' is the terminal state,
// not a gradeable hop. Wholesale has NO Shopify leg: no shopify_order,
// allocator_split or back_sync hop, which is exactly why it can never be graded
// on a missing WebId. Exported so the writer glue can assemble hops per channel.
export const CHANNEL_STAGES: Record<Channel, LifecycleStage[]> = {
  dtc: [
    'shopify_order',
    'allocator_split',
    'nav_staging',
    'nav_promotion',
    'awaiting_ship',
    'nav_shipment',
    'back_sync',
  ],
  wholesale: ['nav_promotion', 'awaiting_ship', 'nav_shipment'],
};

// One observed hop in an order's march through the chain.
export interface OrderHop {
  stage: LifecycleStage;
  completedAt: string | null; // handoff to the next stage happened (ISO) or null if not yet
  enteredAt: string | null;   // when the order arrived at this hop (ages an incomplete hop)
  error: string | null;       // latched error on this hop => RED (blocked SKU, missed back-sync)
}

// Seeded, source-shaped input for one order. Timestamps are ISO strings (or null
// when a source has not reported). hops are in canonical chain order.
export interface OrderInput {
  channel: Channel;
  navOrderNo: string | null;
  shopifyOrderName: string | null;
  customerRef: string | null;
  webId: string | null; // Shopify correlation key; empty on a DTC orphan (never on wholesale)
  hops: OrderHop[];
}

// Age in seconds of an ISO timestamp relative to nowMs. null-safe.
function ageSeconds(iso: string | null, nowMs: number): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

// An empty WebId is null, '', or whitespace (the back_sync.rs:552 "orphan or
// wholesale" case). Used only for DTC; wholesale never reaches orphan grading.
function isEmptyWebId(webId: string | null): boolean {
  return webId === null || webId.trim() === '';
}

// Pick the SLO band for a stage. awaiting_ship uses the 3PL band; everything
// else uses the generic staging/promotion band.
function stageBand(stage: LifecycleStage, t: OrderThresholds): { amber: number; red: number } {
  if (stage === 'awaiting_ship') {
    return { amber: t.awaitingShipAmberSeconds, red: t.awaitingShipRedSeconds };
  }
  return { amber: t.stageAmberSeconds, red: t.stageRedSeconds };
}

// Grade one hop (design.md 3.1): a latched error is RED; a completed handoff is
// GREEN; an in-flight hop is GREEN under its SLO, AMBER within, RED past it. An
// in-flight hop with no entry time is 'unknown' (source not yet reporting).
function gradeHop(hop: OrderHop, t: OrderThresholds, nowMs: number): Verdict {
  if (hop.error !== null && hop.error !== '') return 'red';
  if (hop.completedAt !== null) return 'green';
  const age = ageSeconds(hop.enteredAt, nowMs);
  if (age === null) return 'unknown';
  const band = stageBand(hop.stage, t);
  if (age >= band.red) return 'red';
  if (age >= band.amber) return 'amber';
  return 'green';
}

// Grade one order: worst verdict across the hops it has actually reached, plus
// the flagged orphan signal. Hops after the current pending one are FUTURE (not
// yet due) and are not graded, so a healthy in-flight order is not dragged to
// 'unknown' by stages it has not reached yet.
export function gradeOrder(input: OrderInput, t: OrderThresholds, nowMs: number): OrderHealth {
  const firstIncompleteIdx = input.hops.findIndex((h) => h.completedAt === null);
  const allComplete = firstIncompleteIdx === -1;

  // Grade the completed prefix plus the current pending hop; skip future hops.
  const active = allComplete ? input.hops : input.hops.slice(0, firstIncompleteIdx + 1);
  const hopVerdicts = active.map((h) => gradeHop(h, t, nowMs));

  const currentStage: LifecycleStage = allComplete
    ? 'complete'
    : input.hops[firstIncompleteIdx]!.stage;

  // Oldest stuck age = how long the order has been sitting at its current hop.
  const oldestStuckAgeS = allComplete
    ? null
    : ageSeconds(input.hops[firstIncompleteIdx]!.enteredAt, nowMs);

  // ORPHAN GRADING (behind the flag; wholesale is structurally excluded by the
  // channel === 'dtc' guard, so it is never mis-graded an orphan).
  const orphanSuspect =
    t.orphanGradingEnabled && input.channel === 'dtc' && isEmptyWebId(input.webId);

  const verdicts = orphanSuspect ? [...hopVerdicts, 'red' as Verdict] : hopVerdicts;
  const orderVerdict = worstVerdict(verdicts);

  const latchedError = input.hops.map((h) => h.error).find((e) => e !== null && e !== '') ?? null;
  const note = orphanSuspect
    ? 'DTC order with empty WebId: orphan suspect (grading behind ORDER_ORPHAN_GRADING_ENABLED, BA Q1)'
    : latchedError;

  const isDtc = input.channel === 'dtc';
  return {
    channel: input.channel,
    nav_order_no: input.navOrderNo,
    // Shopify-leg identity only for DTC; wholesale has no Shopify object to show.
    shopify_order_id: isDtc && !isEmptyWebId(input.webId) ? input.webId : null,
    shopify_order_name: isDtc ? input.shopifyOrderName : null,
    customer_ref: input.customerRef,
    current_stage: currentStage,
    order_verdict: orderVerdict,
    oldest_stuck_age_s: oldestStuckAgeS,
    is_orphan_suspect: orphanSuspect,
    note,
  };
}

// Grade a batch of orders. Pure: same inputs + thresholds + nowMs => same rows.
export function computeOrderRows(
  inputs: OrderInput[],
  thresholds: OrderThresholds,
  nowMs: number,
): OrderHealth[] {
  return inputs.map((o) => gradeOrder(o, thresholds, nowMs));
}

// Reference channel-filter semantics: the same predicate the read API's SQL
// WHERE clause implements ('all' returns both channels). Exported so the filter
// is unit-testable without a live database.
export function filterOrdersByChannel(rows: OrderHealth[], filter: ChannelFilter): OrderHealth[] {
  if (filter === 'all') return rows;
  return rows.filter((r) => r.channel === filter);
}
