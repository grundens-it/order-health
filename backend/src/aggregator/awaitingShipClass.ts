// Round 3 (Unit 1): the PURE awaiting_ship classifier. Given the FS-location
// available (read read-only from Shopify) reconciled against NAV warehouse on-hand,
// plus the order's age and identity, it names WHY an order has not shipped. No I/O:
// the writer gathers the numbers (FS read in the Shopify client, NAV availability
// read), feeds them here, and this returns the classification + the human "why".
//
// The dominant cause today is the Symmetry Fulfillment Service (FS) floor-at-zero
// bug: the FS location holds a NEGATIVE available while the warehouses are stocked,
// so Shopify will not release the order even though stock exists. That is NOT a 3PL
// delay and must not be chased as one; it is an FS re-floor (ADR-0003).
import type { AwaitingShipClass, AwaitingShipDetail } from '@order-health/shared';

export interface AwaitingShipClassInput {
  ageS: number | null;                 // how long awaiting shipment
  fsAvailable: number | null;          // Shopify FS-location available (null = unread)
  navWarehouseOnHand: number | null;   // NAV warehouse on-hand across warehouses (null = unread)
  sampleSku: string | null;            // representative SKU driving the classification
  hasNavOrder: boolean;                // a NAV order backs this record
  hasShopifyOrder: boolean;            // a Shopify order backs this record
  isReturn: boolean;                   // a Happy Return / non-sales record (HR- etc.)
  backorder: boolean;                  // a line is warehouse-short / on a future IABC date
}

function days(ageS: number | null): string {
  if (ageS === null) return 'unknown age';
  const d = ageS / 86400;
  return d >= 1 ? `${d.toFixed(1)}d` : `${Math.round(ageS / 3600)}h`;
}

// Classify one awaiting_ship order. Order of tests matters: a phantom/return is not a
// stall at all; the FS floor-at-zero bug is checked before backorder / 3PL so a
// stocked-but-floored order is never mislabelled a delay or a restock.
export function classifyAwaitingShip(input: AwaitingShipClassInput): AwaitingShipDetail {
  const base = {
    age_s: input.ageS,
    fs_available: input.fsAvailable,
    nav_warehouse_on_hand: input.navWarehouseOnHand,
    sample_sku: input.sampleSku,
  };
  let classification: AwaitingShipClass;
  let why: string;

  if (input.isReturn) {
    classification = 'return';
    why = 'Happy Return / non-sales record; not an outbound shipment stall';
  } else if (!input.hasNavOrder && !input.hasShopifyOrder) {
    classification = 'orphan_or_return';
    why = 'No NAV order and no Shopify order behind this record (phantom, not a stall)';
  } else if (
    input.fsAvailable !== null &&
    input.fsAvailable < 0 &&
    input.navWarehouseOnHand !== null &&
    input.navWarehouseOnHand > 0
  ) {
    classification = 'fs_floor_at_zero';
    why =
      `awaiting_ship ${days(input.ageS)}; FS available ${input.fsAvailable} while warehouse ` +
      `on-hand ${input.navWarehouseOnHand}` +
      (input.sampleSku ? ` (${input.sampleSku})` : '') +
      ' -> FS floor-at-zero: re-floor the FS location (ADR-0003), not a 3PL chase';
  } else if (input.backorder) {
    classification = 'backordered';
    why =
      `awaiting_ship ${days(input.ageS)}; a line is warehouse-short` +
      (input.sampleSku ? ` (${input.sampleSku})` : '') +
      ' -> backordered, needs restock (not a 3PL chase)';
  } else {
    classification = 'genuine_3pl_delay';
    const fs = input.fsAvailable !== null ? `FS available ${input.fsAvailable}` : 'in stock';
    why = `awaiting_ship ${days(input.ageS)}; ${fs}, unshipped past the SLO -> genuine 3PL delay, chase it`;
  }

  return { classification, why, ...base };
}
