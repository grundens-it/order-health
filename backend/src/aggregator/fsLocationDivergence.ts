// Per-location availability divergence monitor (WI2 #88): the 2026-07-17 leading
// indicator.
//
// This mirrors the other pipe computes: a PURE function of seeded inputs and
// thresholds (no I/O, no clock beyond nowMs), so every boundary is unit-testable
// without a live NAV or middleware. writers.ts reads the NAV IABC availability at
// HF1FTZ (read-only) and the middleware's FS-location availability, assembles the
// input, and calls computeFsLocationDivergence here.
//
// The divergence it detects is the exact incident condition: NAV shows stock at
// HF1FTZ (Qty Available > 0, Earliest Shipment Date <= today) while the FS-location
// availability reads 0 (or negative). This is SEPARATE from the catalog
// inventory-sync freshness/liveness pipe, which was green during the incident.
import type {
  FsLocationDivergenceDetail,
  FsLocationDivergenceItem,
  Verdict,
} from '@order-health/shared';

export interface FsDivergenceThresholds {
  divergedAmberCount: number; // diverged SKUs >= this => AMBER
  divergedRedCount: number;   // ...>= this => RED
}

// The NAV IABC side, per SKU, already scoped to the HF1FTZ location by the reader.
export interface NavLocationAvailabilityRow {
  sku: string;
  available: number | null;          // Qty Available at HF1FTZ (> 0 = stocked)
  onHand: number | null;             // Qty On Hand at HF1FTZ (null when unread)
  earliestShipmentDate: string | null; // Earliest Shipment Date (null when unread)
}

export interface FsLocationDivergenceInput {
  navAtLocation: NavLocationAvailabilityRow[];
  // The FS-location availability per SKU. null = the FS source was not read, which
  // grades 'unknown' (never a false green). A present-but-empty map is a real
  // reading (nothing diverged) and grades green.
  fsAvailBySku: Map<string, number | null> | null;
  navLocation: string;       // the NAV location compared (HF1FTZ)
  fsSource: string;          // the middleware read used for the FS side
  fsSourceIsProxy: boolean;  // true when a proxy stands in for a clean per-location read
  maxItems?: number;         // cap on the diverging-item list carried in detail
}

export interface FsLocationDivergenceResult {
  divergenceVerdict: Verdict;
  detail: FsLocationDivergenceDetail;
}

function countBandVerdict(count: number | null, amber: number, red: number): Verdict {
  if (count === null) return 'unknown';
  if (count >= red) return 'red';
  if (count >= amber) return 'amber';
  return 'green';
}

// Is the NAV row's Earliest Shipment Date on or before today? A null date is
// treated as eligible (best-effort): the item-ledger-derived NAV read does not
// carry a ship date, so we do not exclude a stocked SKU for lack of one. When the
// IABC ship-date column is wired (see DATA_SOURCES.md follow-up) this excludes
// future-dated stock.
function shipDateReached(iso: string | null, nowMs: number): boolean {
  if (iso === null) return true;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  return t <= nowMs;
}

// Compute the divergence. Pure: same inputs + thresholds + nowMs => same result.
export function computeFsLocationDivergence(
  input: FsLocationDivergenceInput,
  thresholds: FsDivergenceThresholds,
  nowMs: number,
): FsLocationDivergenceResult {
  const baseDetail = {
    nav_location: input.navLocation,
    fs_source: input.fsSource,
    fs_source_is_proxy: input.fsSourceIsProxy,
  };

  // FS source unread => unknown, never a false green.
  if (input.fsAvailBySku === null) {
    return {
      divergenceVerdict: 'unknown',
      detail: {
        ...baseDetail,
        divergence_verdict: 'unknown',
        checked: null,
        diverged_count: null,
        items: [],
      },
    };
  }

  const cap = input.maxItems ?? 100;
  const items: FsLocationDivergenceItem[] = [];
  let checked = 0;
  let diverged = 0;

  for (const nav of input.navAtLocation) {
    // NAV must show real, shippable stock at HF1FTZ to expect FS to hold it.
    if (nav.available === null || nav.available <= 0) continue;
    if (!shipDateReached(nav.earliestShipmentDate, nowMs)) continue;
    // We can only assert a divergence when the FS side actually reported this SKU.
    if (!input.fsAvailBySku.has(nav.sku)) continue;
    checked += 1;
    const fs = input.fsAvailBySku.get(nav.sku) ?? null;
    if (fs !== null && fs <= 0) {
      diverged += 1;
      if (items.length < cap) {
        items.push({
          sku: nav.sku,
          nav_available: nav.available,
          nav_on_hand: nav.onHand,
          earliest_shipment_date: nav.earliestShipmentDate,
          fs_available: fs,
          note:
            `NAV shows ${nav.available} available at ${input.navLocation} but the FS location ` +
            `reads ${fs}; the allocator will bounce this SKU and drop the line to OutOfStock`,
        });
      }
    }
  }

  const verdict = countBandVerdict(diverged, thresholds.divergedAmberCount, thresholds.divergedRedCount);

  return {
    divergenceVerdict: verdict,
    detail: {
      ...baseDetail,
      divergence_verdict: verdict,
      checked,
      diverged_count: diverged,
      items,
    },
  };
}
