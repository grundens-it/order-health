// Pure Shopify reconciliation functions (ADR-0007 / ADR-0009). Each takes the
// middleware/NAV claim plus the Shopify read and returns a ShopifyReconciliation:
// where they diverge, how many were checked, and whether Shopify was reachable.
// Surface-only: these NEVER change a pipe verdict, they annotate the detail so the
// panel can point at the exact SKU / order / shipment that differs. PURE: no I/O.
import type { ShopifyDivergenceItem, ShopifyReconciliation } from '@order-health/shared';
import type {
  ShopifyFulfillmentState,
  ShopifyInventoryLevel,
  ShopifyOrderArrival,
  ShopifyVariantPrice,
} from '../sources/shopifyClient';

function result(available: boolean, checked: number, divergences: ShopifyDivergenceItem[]): ShopifyReconciliation {
  return {
    source: 'shopify-admin',
    available,
    checked,
    reconciled: checked > 0 && divergences.length === 0,
    divergences,
  };
}

// back_sync: a NAV shipment posted but Shopify shows NO fulfillment for that order
// is the divergence to surface (regardless of what the middleware feed claims). An
// empty Shopify read means unavailable (unknown), not "all reconciled".
export function reconcileBackSync(
  navShippedOrderNames: readonly string[],
  states: readonly ShopifyFulfillmentState[],
): ShopifyReconciliation {
  if (states.length === 0) return result(false, 0, []);
  const byName = new Map(states.map((s) => [s.orderName, s]));
  const divergences: ShopifyDivergenceItem[] = [];
  let checked = 0;
  for (const name of navShippedOrderNames) {
    const s = byName.get(name);
    if (s === undefined) continue; // not in the Shopify sample; not comparable
    checked += 1;
    if (!s.fulfilled) {
      divergences.push({
        key: name,
        nav: 'shipment posted',
        shopify: s.displayStatus ?? 'unfulfilled',
        note: 'NAV shipment posted but Shopify shows no fulfillment',
      });
    }
  }
  return result(true, checked, divergences);
}

// inventory_sync: the middleware claims it pushed NAV availability to Shopify. The
// divergence is a SKU whose Shopify available quantity differs from the NAV
// availability by more than `tolerance`. Compared per SKU (summing locations when
// the middleware works at the SKU level).
export function reconcileInventory(
  navAvailabilityBySku: ReadonlyMap<string, number>,
  levels: readonly ShopifyInventoryLevel[],
  tolerance = 0,
): ShopifyReconciliation {
  if (levels.length === 0) return result(false, 0, []);
  const shopBySku = new Map<string, number>();
  for (const l of levels) {
    if (l.available === null) continue;
    shopBySku.set(l.sku, (shopBySku.get(l.sku) ?? 0) + l.available);
  }
  const divergences: ShopifyDivergenceItem[] = [];
  let checked = 0;
  for (const [sku, shopQty] of shopBySku) {
    const navQty = navAvailabilityBySku.get(sku);
    if (navQty === undefined) continue;
    checked += 1;
    if (Math.abs(navQty - shopQty) > tolerance) {
      divergences.push({
        key: sku,
        nav: navQty,
        shopify: shopQty,
        note: `NAV availability ${navQty} but Shopify holds ${shopQty}`,
      });
    }
  }
  return result(true, checked, divergences);
}

// price_sync: a spot-check of NAV price vs the Shopify variant price per SKU. A
// difference beyond `tolerance` (currency units) is a divergence.
export function reconcilePrice(
  navPriceBySku: ReadonlyMap<string, number>,
  shopifyPrices: readonly ShopifyVariantPrice[],
  tolerance = 0.005,
): ShopifyReconciliation {
  if (shopifyPrices.length === 0) return result(false, 0, []);
  const divergences: ShopifyDivergenceItem[] = [];
  let checked = 0;
  for (const p of shopifyPrices) {
    if (p.price === null) continue;
    const navPrice = navPriceBySku.get(p.sku);
    if (navPrice === undefined) continue;
    checked += 1;
    if (Math.abs(navPrice - p.price) > tolerance) {
      divergences.push({
        key: p.sku,
        nav: navPrice,
        shopify: p.price,
        note: `NAV price ${navPrice} but Shopify price ${p.price}`,
      });
    }
  }
  return result(true, checked, divergences);
}

// shopify_webhook outcome: a Shopify order that Shopify created but that never
// ARRIVED in NAV (no matching NAV order) is a webhook-delivery / forward-sync gap.
// The NAV arrival set is the order names NAV knows about.
export function reconcileWebhookOutcome(
  shopifyOrders: readonly ShopifyOrderArrival[],
  navArrivedOrderNames: ReadonlySet<string>,
): ShopifyReconciliation {
  if (shopifyOrders.length === 0) return result(false, 0, []);
  const divergences: ShopifyDivergenceItem[] = [];
  let checked = 0;
  for (const o of shopifyOrders) {
    if (o.name.length === 0) continue;
    checked += 1;
    if (!navArrivedOrderNames.has(o.name)) {
      divergences.push({
        key: o.name,
        nav: 'not arrived',
        shopify: o.createdAt ?? 'created',
        note: 'Shopify order has no matching NAV arrival (webhook / forward-sync gap)',
      });
    }
  }
  return result(true, checked, divergences);
}
