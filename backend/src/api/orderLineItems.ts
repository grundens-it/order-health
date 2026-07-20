// Pure body-builder for the "Line items" DIAGNOSE read (GET /api/diagnostics/
// shopify-order/:id). The middleware GET /api/shopify/order/:id (main.rs:858,
// shopify::orders::handle_fetch_order) returns the Shopify order in Shopify Admin
// REST shape, possibly wrapped in { order: { ... } }. Operators only need the SKU,
// the quantity and a human line name to see what is actually on a held order (the
// held-SKU field is often blank, especially for Not-in-NAV orders). This function
// is pure + isolated from the Fastify route so it is unit-testable without a live
// middleware or the server wiring.

export interface OrderLineItem {
  sku: string;
  quantity: number;
  name: string;
}

// Extract the line items from an unknown Shopify-order payload, tolerating both the
// bare order object and the { order: { ... } } envelope, and the line naming
// variants Shopify uses (name, or title with an optional variant_title). Never
// throws: a malformed / empty payload yields an empty list so the modal renders
// "no line items" rather than crashing.
export function buildOrderLineItems(json: unknown): { line_items: OrderLineItem[] } {
  const root = json !== null && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  const orderObj =
    root.order !== null && typeof root.order === 'object'
      ? (root.order as Record<string, unknown>)
      : root;
  const raw = orderObj.line_items;
  const lines = Array.isArray(raw) ? raw : [];
  const items: OrderLineItem[] = [];
  for (const li of lines) {
    if (li === null || typeof li !== 'object') continue;
    const row = li as Record<string, unknown>;
    const sku = row.sku !== null && row.sku !== undefined ? String(row.sku) : '';
    const qtyNum = Number(row.quantity);
    const quantity = Number.isFinite(qtyNum) ? qtyNum : 0;
    const title = row.title !== null && row.title !== undefined ? String(row.title) : '';
    const variant =
      row.variant_title !== null && row.variant_title !== undefined ? String(row.variant_title) : '';
    let name = row.name !== null && row.name !== undefined ? String(row.name) : '';
    if (name.length === 0) name = variant.length > 0 ? `${title} (${variant})` : title;
    items.push({ sku, quantity, name });
  }
  return { line_items: items };
}
