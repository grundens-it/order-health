// OOS-held backlog monitor (WI1 #87) + NAV-conditioned remediation routing (WI3 #89).
//
// This mirrors allocator.ts / inventorySync.ts: a PURE function of seeded inputs
// and thresholds (no I/O, no clock read beyond the injected nowMs), so every
// verdict boundary and every routing rule is unit-testable without a live NAV or
// middleware. writers.ts reads the read-only /api/oos-held backlog, joins each row
// to NAV (the WI3 bucket), and calls computeOosHeld here.
//
// WI1: the OOS-held backlog is promoted from a buried count on the allocator pipe
// (allocator.ts leaves it out of failed_rate on purpose) to its OWN graded signal.
// The ALERTING population is transient-class rows that are not resolved; the depth
// of that queue and the age of its needs_operator rows drive the verdict.
// backorder-class rows are legitimate warehouse shorts and NEVER drive red.
//
// WI3: a plain re-drive (forward_sync_replay) no-ops on most held orders because
// the middleware returns DuplicateSkip when allocations exist AND the order is
// already in NAV. So each held order is joined to NAV and bucketed, and the RIGHT
// remediation is routed by the bucket (routeHeldOrder). forward_sync_replay is
// mapped ONLY to a not-in-NAV order.
import type {
  OosHeldDetail,
  OosHeldNavBucket,
  OosHeldOrder,
  Verdict,
} from '@order-health/shared';
import { worstVerdict } from '@order-health/shared';

export interface OosHeldThresholds {
  depthAmberCount: number; // alerting held rows >= this => AMBER
  depthRedCount: number;   // ...>= this => RED
  ageAmberSeconds: number; // oldest needs_operator row age >= this => AMBER
  ageRedSeconds: number;   // ...>= this => RED
}

// Seeded input: the held-order rows (or null when the source is unread, which
// grades 'unknown', never a false green). Rows may already carry their WI3
// nav_bucket (from the writer's NAV join); computeOosHeld tallies the buckets it
// finds but does not require them.
export interface OosHeldInput {
  heldOrders: OosHeldOrder[] | null;
}

export interface OosHeldResult {
  heldVerdict: Verdict;
  detail: OosHeldDetail;
}

// Age in seconds of an ISO timestamp relative to nowMs. null-safe.
function ageSeconds(iso: string | null, nowMs: number): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

// A count-banded verdict: green under amber, amber up to red, red at or beyond
// red. A null count is 'unknown' (source not reporting).
function countBandVerdict(count: number | null, amber: number, red: number): Verdict {
  if (count === null) return 'unknown';
  if (count >= red) return 'red';
  if (count >= amber) return 'amber';
  return 'green';
}

// A seconds-banded verdict, but a null age here means "no needs_operator row"
// (a real green), NOT unknown: computeOosHeld only calls this once it knows the
// source was read.
function ageBandVerdict(ageS: number | null, amber: number, red: number): Verdict {
  if (ageS === null) return 'green';
  if (ageS >= red) return 'red';
  if (ageS >= amber) return 'amber';
  return 'green';
}

// The ALERTING population: transient-class rows that are not resolved. A held row
// is only alerting when it is a transient miss still stuck; backorder-class rows
// and resolved rows are excluded so they can never drive the verdict.
function isAlerting(o: OosHeldOrder): boolean {
  return o.held_class === 'transient' && o.status !== 'resolved';
}
function isNeedsOperator(o: OosHeldOrder): boolean {
  return o.held_class === 'transient' && o.status === 'needs_operator';
}

// WI3 routing. Given the NAV-join facts for one held order, name the bucket and
// the remediation tool. This is the single rule the duplicate-skip test pins:
// forward_sync_replay is returned ONLY for a not-in-NAV order; an in-NAV order
// (where a re-drive returns DuplicateSkip) never routes to it.
export interface HeldNavFacts {
  // NAV presence is PER-ORDER-ACROSS-ALL-LINES: an order has NAV footprint when a
  // GRUS$Sales Header exists (open leg) OR a GRUS$Sales Shipment Header exists (a
  // leg already shipped). A partially-shipped order whose open legs are gone is
  // still "in NAV" and must NOT route to the no-op re-drive.
  inNav: boolean;
  droppedSku: string | null; // the SKU the hold is about (from last_detail), null when unknown
  navLineSkus: string[];     // SKUs on OPEN NAV legs (GRUS$Sales Line, outstanding > 0)
  shippedSkus?: string[];    // SKUs on POSTED shipments (GRUS$Sales Shipment Line); optional, defaults to []
}

export interface HeldRoute {
  bucket: OosHeldNavBucket;
  toolId: string;
}

// The tool ids the router maps to (kept here so the registry and the router agree
// on one spelling). forward_sync_replay is the ONLY re-drive, and only for
// not-in-NAV.
export const FORWARD_SYNC_REPLAY_TOOL = 'forward_sync_replay';
export const NAV_LINE_ADD_TOOL = 'oos_held_nav_line_add';
export const STALE_HOLD_CLEAR_TOOL = 'oos_held_stale_clear';

export function routeHeldOrder(facts: HeldNavFacts): HeldRoute {
  // The "present" set is evaluated ACROSS ALL LINES of the order: a SKU counts as
  // present if it is on an open NAV leg OR already shipped. This is the fix for
  // partially-shipped orders: the shipped legs prove the order reached NAV even
  // when its open Sales Header is gone.
  const presentSkus = [...facts.navLineSkus, ...(facts.shippedSkus ?? [])];

  // Not in NAV at all (no open leg, no shipment): the order never reached NAV, so
  // a re-drive re-stages it. This is the ONLY case forward_sync_replay is valid.
  if (!facts.inNav) {
    return { bucket: 'not_in_nav', toolId: FORWARD_SYNC_REPLAY_TOOL };
  }
  // In NAV (some line shipped or is open) but the held line's SKU is on NEITHER an
  // open leg NOR a shipment: that line was DROPPED at intake (oversold) and never
  // staged. A whole-order re-drive returns DuplicateSkip and no-ops, so this routes
  // to creating the missing NAV leg, NEVER to forward_sync_replay.
  if (facts.droppedSku !== null && !presentSkus.includes(facts.droppedSku)) {
    return { bucket: 'in_nav_line_missing', toolId: NAV_LINE_ADD_TOOL };
  }
  // In NAV with the held line present (open or shipped): the order reached NAV with
  // this line; the hold record is stale. An ops step verifies and clears it.
  return { bucket: 'in_nav_line_present', toolId: STALE_HOLD_CLEAR_TOOL };
}

// Enrich a held order with its WI3 bucket + routed tool from the NAV-join facts.
// Pure: returns a new row, never mutates the input.
export function bucketHeldOrder(order: OosHeldOrder, facts: HeldNavFacts): OosHeldOrder {
  const route = routeHeldOrder(facts);
  return { ...order, nav_bucket: route.bucket, remediation_tool_id: route.toolId };
}

// Extract the dropped SKU from a held row's last_detail, best-effort. The middleware
// writes the offending style / SKU into last_detail (e.g. "OutOfStock 50625-425").
// A confident style token (NNNNN-NNN) is preferred; otherwise null (unknown), which
// makes the router treat the order as line-present (an ops verify), never a re-drive.
export function extractDroppedSku(detail: string | null): string | null {
  if (detail === null) return null;
  const style = detail.match(/\b\d{4,6}-\d{2,4}\b/);
  return style ? style[0] : null;
}

// The three-verdict-style compute (here two bands: depth + age). Pure: same input
// + thresholds + nowMs => same result.
export function computeOosHeld(
  input: OosHeldInput,
  thresholds: OosHeldThresholds,
  nowMs: number,
): OosHeldResult {
  // Source unread => unknown, never a false green.
  if (input.heldOrders === null) {
    return {
      heldVerdict: 'unknown',
      detail: {
        held_verdict: 'unknown',
        total_count: null,
        alerting_count: null,
        needs_operator_count: null,
        backorder_count: null,
        oldest_age_s: null,
        oldest_alerting_age_s: null,
        not_in_nav_count: null,
        in_nav_line_missing_count: null,
        in_nav_line_present_count: null,
        reason_counts: {},
        held_orders: [],
      },
    };
  }

  // Fill per-row age (age_s null on the wire; the grader owns nowMs).
  const rows: OosHeldOrder[] = input.heldOrders.map((o) => ({
    ...o,
    age_s: o.age_s ?? ageSeconds(o.first_seen_at, nowMs),
  }));

  let alertingCount = 0;
  let needsOperatorCount = 0;
  let backorderCount = 0;
  let oldestAgeS: number | null = null;
  let oldestAlertingAgeS: number | null = null;
  const reasonCounts: Record<string, number> = {};
  let notInNav = 0;
  let lineMissing = 0;
  let linePresent = 0;

  for (const o of rows) {
    if (o.held_class === 'backorder') backorderCount += 1;
    if (isAlerting(o)) alertingCount += 1;
    if (isNeedsOperator(o)) {
      needsOperatorCount += 1;
      if (o.age_s !== null && (oldestAlertingAgeS === null || o.age_s > oldestAlertingAgeS)) {
        oldestAlertingAgeS = o.age_s;
      }
    }
    if (o.age_s !== null && (oldestAgeS === null || o.age_s > oldestAgeS)) {
      oldestAgeS = o.age_s;
    }
    if (o.last_detail !== null) {
      reasonCounts[o.last_detail] = (reasonCounts[o.last_detail] ?? 0) + 1;
    }
    if (o.nav_bucket === 'not_in_nav') notInNav += 1;
    else if (o.nav_bucket === 'in_nav_line_missing') lineMissing += 1;
    else if (o.nav_bucket === 'in_nav_line_present') linePresent += 1;
  }

  const depthVerdict = countBandVerdict(alertingCount, thresholds.depthAmberCount, thresholds.depthRedCount);
  const ageVerdict = ageBandVerdict(oldestAlertingAgeS, thresholds.ageAmberSeconds, thresholds.ageRedSeconds);
  const heldVerdict = worstVerdict([depthVerdict, ageVerdict]);

  // Bucket tallies are only meaningful once the join ran (any row carries a bucket).
  const anyBucketed = rows.some((o) => o.nav_bucket !== null);

  return {
    heldVerdict,
    detail: {
      held_verdict: heldVerdict,
      total_count: rows.length,
      alerting_count: alertingCount,
      needs_operator_count: needsOperatorCount,
      backorder_count: backorderCount,
      oldest_age_s: oldestAgeS,
      oldest_alerting_age_s: oldestAlertingAgeS,
      not_in_nav_count: anyBucketed ? notInNav : null,
      in_nav_line_missing_count: anyBucketed ? lineMissing : null,
      in_nav_line_present_count: anyBucketed ? linePresent : null,
      reason_counts: reasonCounts,
      held_orders: rows,
    },
  };
}
