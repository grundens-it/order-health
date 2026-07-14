// Read-only Shopify Admin API client (ADR-0009). The storefront system of record
// for the reconciliations (ADR-0007): order/fulfillment state, inventory levels,
// recent order arrivals, and prices.
//
// BOUNDARY: GraphQL Admin API, QUERY ONLY. Three defences make a write impossible:
//   1. Least-privilege READ scopes on the custom-app credential (no write scope).
//   2. assertNoMutation rejects any GraphQL operation whose body is a `mutation`.
//   3. The client exposes only query methods; it never constructs a mutation.
// It adds nothing to Shopify and never mutates. The only write in the whole system
// remains this service's own snapshot row.
//
// AUTH: client-credentials (ADR-0009). A token manager fetches a (~24h) Admin API
// access token from the shop's OAuth token endpoint, caches it, and refreshes it
// before expiry. The client secret lives only in the gitignored .env / host secret
// store and is never logged.
//
// LIVE vs STUB: createShopifyClient() returns the live client only when the shop,
// clientId and clientSecret are all configured; otherwise the read-only stub answers
// with typed empty shapes so the app boots and the reconciliations read 'unknown'
// rather than a false green. On any auth/fetch/parse failure the live client degrades
// once to the stub. No network request is made at import time.
import { config } from '../config';

// --- Typed read shapes (one per reconciliation) ----------------------------
export interface ShopifyFulfillmentState {
  orderName: string;          // Shopify order name (e.g. "#1024" / "SP-319090")
  fulfilled: boolean;         // at least one fulfillment exists
  displayStatus: string | null; // FULFILLED / UNFULFILLED / PARTIALLY_FULFILLED / ...
}

export interface ShopifyInventoryLevel {
  sku: string;
  locationName: string | null;
  available: number | null;   // units Shopify holds at that location
}

export interface ShopifyOrderArrival {
  name: string;               // Shopify order name
  createdAt: string | null;   // when Shopify created the order (ISO)
}

export interface ShopifyVariantPrice {
  sku: string;
  price: number | null;       // Shopify variant price
  currency: string | null;
}

// Round 3 (Unit 1). The inventory Shopify holds at the FULFILLMENT SERVICE location,
// per SKU. available < 0 is the Symmetry FS floor-at-zero bug. The FS location is
// HIDDEN from Shopify locations(); it is reached via inventoryItem -> inventoryLevel
// and identified by NAME ("Grundens Fulfillment Service"), never a hardcoded id.
export interface ShopifyFsInventory {
  sku: string;
  available: number | null;   // FS-location available (negative = floor-at-zero bug)
  onHand: number | null;      // FS-location on hand
  committed: number | null;   // FS-location committed
}

// The name of the Fulfillment Service location, resolved dynamically (not by id).
export const FS_LOCATION_NAME = 'Grundens Fulfillment Service';

export interface ShopifyClient {
  // back_sync: for a set of NAV-shipped orders, does Shopify show a fulfillment?
  getFulfillmentStates(orderNames: string[]): Promise<ShopifyFulfillmentState[]>;
  // inventory_sync: Shopify inventory levels for a set of SKUs.
  getInventoryLevels(skus: string[]): Promise<ShopifyInventoryLevel[]>;
  // shopify_webhook: recent Shopify orders (outcome reconciliation vs NAV arrival).
  getRecentOrders(sinceIso: string): Promise<ShopifyOrderArrival[]>;
  // price_sync: Shopify variant prices for a set of SKUs (spot-check vs NAV).
  getVariantPrices(skus: string[]): Promise<ShopifyVariantPrice[]>;
  // Round 3: FS-location available/on-hand/committed per SKU (floor-at-zero detection).
  getFsInventory(skus: string[]): Promise<ShopifyFsInventory[]>;
}

// ---------------------------------------------------------------------------
// PURE HELPERS (no I/O). The unit-tested surface: the mutation guard, the token
// request builder, the URL builders, the token-expiry predicate, and the mappers
// that turn a fake GraphQL body into the typed shapes. None touch fetch.
// ---------------------------------------------------------------------------

// Reject any GraphQL operation that is a mutation. Read-only defence in depth on
// top of the read-only scopes. A leading operation keyword `mutation` (named or
// anonymous) is rejected; queries and the `query` keyword pass.
const MUTATION_RE = /(^|\})\s*mutation\b/i;
export function assertNoMutation(gql: string): void {
  if (MUTATION_RE.test(gql)) {
    throw new Error('shopify: refusing a GraphQL mutation (read-only client)');
  }
}

export const SHOPIFY_TOKEN_REFRESH_MARGIN_S = 300; // refresh 5 min before expiry

// The client-credentials token request (ADR-0009). POST form to the shop's OAuth
// token endpoint. Returned as { url, body } so the exact request is testable
// without a network call. The secret is only in the body, never in a URL or log.
export interface ShopifyTokenRequest {
  url: string;
  body: Record<string, string>;
}
export function buildTokenRequest(shopify: typeof config.shopify): ShopifyTokenRequest {
  const shop = shopify.shop.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return {
    url: `https://${shop}/admin/oauth/access_token`,
    body: {
      client_id: shopify.clientId,
      client_secret: shopify.clientSecret,
      grant_type: 'client_credentials',
    },
  };
}

// The Admin GraphQL endpoint for the configured shop + API version.
export function buildGraphqlUrl(shopify: typeof config.shopify): string {
  const shop = shopify.shop.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `https://${shop}/admin/api/${shopify.apiVersion}/graphql.json`;
}

// A cached token is expired (needs refresh) when now is within the refresh margin
// of its expiry. Pure so the refresh boundary is unit-tested without a clock.
export function tokenExpired(
  fetchedAtMs: number | null,
  expiresInS: number | null,
  nowMs: number,
  marginS: number = SHOPIFY_TOKEN_REFRESH_MARGIN_S,
): boolean {
  if (fetchedAtMs === null || expiresInS === null) return true;
  const expiryMs = fetchedAtMs + (expiresInS - marginS) * 1000;
  return nowMs >= expiryMs;
}

// Loose JSON helpers (mirror the other clients).
type Json = Record<string, unknown>;
function pick(o: unknown, ...keys: string[]): unknown {
  if (o === null || typeof o !== 'object') return null;
  for (const k of keys) {
    const v = (o as Json)[k];
    if (v !== undefined && v !== null) return v;
  }
  return null;
}
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}
function edges(connection: unknown): unknown[] {
  const e = pick(connection, 'edges');
  return Array.isArray(e) ? e : [];
}
function node(edge: unknown): Json {
  const n = pick(edge, 'node');
  return n !== null && typeof n === 'object' ? (n as Json) : {};
}

// --- Per-reconciliation mappers (GraphQL body -> typed shapes) --------------

// { data: { orders: { edges: [{ node: { name, displayFulfillmentStatus } }] } } }
export function mapFulfillmentStates(body: unknown): ShopifyFulfillmentState[] {
  const orders = pick(pick(body, 'data'), 'orders');
  return edges(orders).map((e) => {
    const n = node(e);
    const status = str(pick(n, 'displayFulfillmentStatus', 'displayStatus'));
    const upper = (status ?? '').toUpperCase();
    return {
      orderName: str(pick(n, 'name')) ?? '',
      fulfilled: upper === 'FULFILLED' || upper === 'PARTIALLY_FULFILLED',
      displayStatus: status,
    };
  });
}

// { data: { productVariants: { edges: [{ node: { sku, inventoryItem: {
//   inventoryLevels: { edges: [{ node: { location: { name }, quantities: [{ quantity }] } }] } } } }] } } }
export function mapInventoryLevels(body: unknown): ShopifyInventoryLevel[] {
  const variants = pick(pick(body, 'data'), 'productVariants');
  const out: ShopifyInventoryLevel[] = [];
  for (const ve of edges(variants)) {
    const v = node(ve);
    const sku = str(pick(v, 'sku')) ?? '';
    const levels = pick(pick(v, 'inventoryItem'), 'inventoryLevels');
    const levelEdges = edges(levels);
    if (levelEdges.length === 0) {
      out.push({ sku, locationName: null, available: null });
      continue;
    }
    for (const le of levelEdges) {
      const l = node(le);
      const locationName = str(pick(pick(l, 'location'), 'name'));
      // Newer Admin API returns quantities[]; older returns `available`.
      let available = num(pick(l, 'available'));
      if (available === null) {
        const qs = pick(l, 'quantities');
        if (Array.isArray(qs) && qs.length > 0) available = num(pick(qs[0], 'quantity'));
      }
      out.push({ sku, locationName, available });
    }
  }
  return out;
}

// { data: { orders: { edges: [{ node: { name, createdAt } }] } } }
export function mapRecentOrders(body: unknown): ShopifyOrderArrival[] {
  const orders = pick(pick(body, 'data'), 'orders');
  return edges(orders).map((e) => {
    const n = node(e);
    return { name: str(pick(n, 'name')) ?? '', createdAt: str(pick(n, 'createdAt')) };
  });
}

// { data: { productVariants: { edges: [{ node: { sku, price, presentmentPrices... } }] } } }
export function mapVariantPrices(body: unknown): ShopifyVariantPrice[] {
  const variants = pick(pick(body, 'data'), 'productVariants');
  return edges(variants).map((e) => {
    const n = node(e);
    return {
      sku: str(pick(n, 'sku')) ?? '',
      price: num(pick(n, 'price')),
      currency: str(pick(n, 'currencyCode', 'currency')),
    };
  });
}

// Round 3 (Unit 1). Map a productVariants body to per-SKU FS-location inventory,
// selecting the inventory level whose location NAME matches the Fulfillment Service
// (the FS location is hidden from locations(); it is identified by name here, not a
// hardcoded id). Shape:
// { data: { productVariants: { edges: [{ node: { sku, inventoryItem: {
//   inventoryLevels: { edges: [{ node: { location: { name },
//     quantities: [{ name: 'available'|'on_hand'|'committed', quantity }] } }] } } } }] } } }
export function mapFsInventory(body: unknown, fsLocationName: string): ShopifyFsInventory[] {
  const variants = pick(pick(body, 'data'), 'productVariants');
  const out: ShopifyFsInventory[] = [];
  for (const ve of edges(variants)) {
    const v = node(ve);
    const sku = str(pick(v, 'sku')) ?? '';
    const levels = edges(pick(pick(v, 'inventoryItem'), 'inventoryLevels'));
    let fs: ShopifyFsInventory | null = null;
    for (const le of levels) {
      const l = node(le);
      const name = str(pick(pick(l, 'location'), 'name'));
      if (name !== fsLocationName) continue;
      const qs = pick(l, 'quantities');
      const byName = new Map<string, number | null>();
      if (Array.isArray(qs)) {
        for (const q of qs) {
          const qn = str(pick(q, 'name'));
          if (qn !== null) byName.set(qn, num(pick(q, 'quantity')));
        }
      }
      fs = {
        sku,
        available: byName.has('available') ? byName.get('available')! : num(pick(l, 'available')),
        onHand: byName.has('on_hand') ? byName.get('on_hand')! : num(pick(l, 'on_hand')),
        committed: byName.has('committed') ? byName.get('committed')! : num(pick(l, 'committed')),
      };
      break;
    }
    // A SKU with no FS-location level reads all-null (unknown), never a false 0.
    out.push(fs ?? { sku, available: null, onHand: null, committed: null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// STUB (kept forever). Returned when Shopify is not configured, and the fallback
// the live client degrades to on failure. Every method returns empty so the
// reconciliations read 'unknown' (never a false green) until Shopify is live.
// ---------------------------------------------------------------------------
export class ShopifyClientStub implements ShopifyClient {
  private note(what: string): void {
    // eslint-disable-next-line no-console
    console.info(`[shopify:stub] ${what} not queried (Shopify not configured / unreachable)`);
  }
  async getFulfillmentStates(orderNames: string[]): Promise<ShopifyFulfillmentState[]> {
    this.note(`fulfillment states (${orderNames.length} orders)`);
    return [];
  }
  async getInventoryLevels(skus: string[]): Promise<ShopifyInventoryLevel[]> {
    this.note(`inventory levels (${skus.length} skus)`);
    return [];
  }
  async getRecentOrders(sinceIso: string): Promise<ShopifyOrderArrival[]> {
    this.note(`recent orders since ${sinceIso}`);
    return [];
  }
  async getVariantPrices(skus: string[]): Promise<ShopifyVariantPrice[]> {
    this.note(`variant prices (${skus.length} skus)`);
    return [];
  }
  async getFsInventory(skus: string[]): Promise<ShopifyFsInventory[]> {
    this.note(`FS-location inventory (${skus.length} skus)`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// LIVE client. Client-credentials token manager + read-only GraphQL executor.
// ---------------------------------------------------------------------------
export const SHOPIFY_TIMEOUT_MS = 8000;

class ShopifyClientLive implements ShopifyClient {
  private readonly cfg: typeof config.shopify;
  private readonly stub = new ShopifyClientStub();
  private token: string | null = null;
  private tokenFetchedAtMs: number | null = null;
  private tokenExpiresInS: number | null = null;
  private degraded = false;

  constructor(cfg: typeof config.shopify) {
    this.cfg = cfg;
  }

  // Fetch/cache/refresh the client-credentials token. Never logs the secret or the
  // token. Throws to the caller's degrade path on failure.
  private async getToken(): Promise<string> {
    if (this.token !== null && !tokenExpired(this.tokenFetchedAtMs, this.tokenExpiresInS, Date.now())) {
      return this.token;
    }
    const req = buildTokenRequest(this.cfg);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SHOPIFY_TIMEOUT_MS);
    try {
      const res = await fetch(req.url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(req.body).toString(),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`token endpoint -> HTTP ${res.status}`);
      const body = (await res.json()) as Json;
      const token = str(pick(body, 'access_token', 'accessToken'));
      if (token === null) throw new Error('token endpoint returned no access_token');
      this.token = token;
      this.tokenExpiresInS = num(pick(body, 'expires_in', 'expiresIn')) ?? 86400;
      this.tokenFetchedAtMs = Date.now();
      return token;
    } finally {
      clearTimeout(timer);
    }
  }

  // Execute a read-only GraphQL query. assertNoMutation is the last gate before the
  // request leaves the process. Returns the parsed JSON body.
  private async query(gql: string, variables?: Json): Promise<unknown> {
    assertNoMutation(gql);
    const token = await this.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SHOPIFY_TIMEOUT_MS);
    try {
      const res = await fetch(buildGraphqlUrl(this.cfg), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Accept: 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({ query: gql, variables: variables ?? {} }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`graphql -> HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private degrade<T>(what: string, err: unknown, fallback: Promise<T>): Promise<T> {
    if (!this.degraded) {
      this.degraded = true;
      // eslint-disable-next-line no-console
      console.warn(`[shopify:live] ${what} failed; degrading to stub (unknown): ${String(err)}`);
    }
    return fallback;
  }

  async getFulfillmentStates(orderNames: string[]): Promise<ShopifyFulfillmentState[]> {
    if (orderNames.length === 0) return [];
    const q = orderNames.map((n) => `name:${JSON.stringify(n)}`).join(' OR ');
    const gql = `query($q: String!) { orders(first: 100, query: $q) { edges { node { name displayFulfillmentStatus } } } }`;
    try {
      return mapFulfillmentStates(await this.query(gql, { q }));
    } catch (err) {
      return this.degrade('fulfillment states', err, this.stub.getFulfillmentStates(orderNames));
    }
  }

  async getInventoryLevels(skus: string[]): Promise<ShopifyInventoryLevel[]> {
    if (skus.length === 0) return [];
    const q = skus.map((s) => `sku:${JSON.stringify(s)}`).join(' OR ');
    const gql = `query($q: String!) { productVariants(first: 100, query: $q) { edges { node { sku inventoryItem { inventoryLevels(first: 10) { edges { node { location { name } quantities(names: ["available"]) { quantity } } } } } } } } }`;
    try {
      return mapInventoryLevels(await this.query(gql, { q }));
    } catch (err) {
      return this.degrade('inventory levels', err, this.stub.getInventoryLevels(skus));
    }
  }

  async getRecentOrders(sinceIso: string): Promise<ShopifyOrderArrival[]> {
    const gql = `query($q: String!) { orders(first: 100, query: $q, sortKey: CREATED_AT, reverse: true) { edges { node { name createdAt } } } }`;
    try {
      return mapRecentOrders(await this.query(gql, { q: `created_at:>=${sinceIso}` }));
    } catch (err) {
      return this.degrade('recent orders', err, this.stub.getRecentOrders(sinceIso));
    }
  }

  async getVariantPrices(skus: string[]): Promise<ShopifyVariantPrice[]> {
    if (skus.length === 0) return [];
    const q = skus.map((s) => `sku:${JSON.stringify(s)}`).join(' OR ');
    const gql = `query($q: String!) { productVariants(first: 100, query: $q) { edges { node { sku price } } } }`;
    try {
      return mapVariantPrices(await this.query(gql, { q }));
    } catch (err) {
      return this.degrade('variant prices', err, this.stub.getVariantPrices(skus));
    }
  }

  async getFsInventory(skus: string[]): Promise<ShopifyFsInventory[]> {
    if (skus.length === 0) return [];
    // The Admin GraphQL productVariants(first: 100) caps each query at 100 variants,
    // so chunk the SKU set into batches of 100 and merge. The FS location is hidden
    // from locations(); we read each variant's inventory levels (which DO include the
    // FS location) and select it by name downstream.
    const gql =
      `query($q: String!) { productVariants(first: 100, query: $q) { edges { node { sku ` +
      `inventoryItem { inventoryLevels(first: 20) { edges { node { location { name } ` +
      `quantities(names: ["available", "on_hand", "committed"]) { name quantity } } } } } } } } }`;
    const out: ShopifyFsInventory[] = [];
    for (let i = 0; i < skus.length; i += 100) {
      const batch = skus.slice(i, i + 100);
      const q = batch.map((s) => `sku:${JSON.stringify(s)}`).join(' OR ');
      try {
        out.push(...mapFsInventory(await this.query(gql, { q }), FS_LOCATION_NAME));
      } catch (err) {
        // Degrade this batch once to the stub (empty), but keep any batches that did
        // succeed so a partial Shopify failure never zeroes the whole read.
        this.degrade('FS-location inventory', err, this.stub.getFsInventory(batch));
      }
    }
    return out;
  }
}

// Factory. Live only when shop + clientId + clientSecret are all present; otherwise
// the read-only stub. The live client fetches its token lazily on first call.
export function createShopifyClient(): ShopifyClient {
  const s = config.shopify;
  const configured = s.shop.length > 0 && s.clientId.length > 0 && s.clientSecret.length > 0;
  if (!configured) {
    // eslint-disable-next-line no-console
    console.info('[shopify] not fully configured; using read-only stub client');
    return new ShopifyClientStub();
  }
  // eslint-disable-next-line no-console
  console.info(
    `[shopify] live read-only Admin API client active (shop=${s.shop}, api=${s.apiVersion}, ` +
      `auth=${s.authMode})`,
  );
  return new ShopifyClientLive(s);
}
