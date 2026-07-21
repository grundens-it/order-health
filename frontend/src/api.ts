// Typed fetch helpers for the backend read API. The shared package supplies the
// response types, so the frontend and backend agree on the as_of envelope.
import type {
  AuthMeResponse,
  ChannelFilter,
  OrdersResponse,
  PipelinesResponse,
  RemediationArmStateResponse,
  RemediationRegistryResponse,
  RemediationTriggerResult,
  RollupResponse,
} from '@order-health/shared';

// A typed API error distinguishing the two failure modes an operator must tell
// apart (Unit 7): a CONNECTION failure (the backend is down / unreachable) versus
// a NON-2XX response (the backend is up but errored, for example its database is
// down). The banner maps each to a different message and remedy.
export type ApiErrorKind = 'network' | 'http';
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    // fetch rejects (TypeError) only when the request never got a response: the
    // backend is down, the port is closed, DNS/network failed. That is "unreachable".
    throw new ApiError('network', `cannot reach the backend at ${url}`);
  }
  if (!res.ok) {
    // The backend answered, just not with a 2xx: it is UP but errored (a 500 from a
    // downed DB, a 4xx, etc.). This is NOT "unreachable".
    throw new ApiError('http', `backend responded ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export function fetchPipelines(): Promise<PipelinesResponse> {
  return getJson<PipelinesResponse>('/api/health/pipelines');
}

export function fetchOrders(channel: ChannelFilter): Promise<OrdersResponse> {
  return getJson<OrdersResponse>(`/api/health/orders?channel=${channel}`);
}

export function fetchRollup(): Promise<RollupResponse> {
  return getJson<RollupResponse>('/api/health/rollup');
}

// The remediation runbook registry (read-only): the modal reads this to name the
// mapped tool for a red signal without re-declaring the runbook.
export function fetchRemediationRegistry(): Promise<RemediationRegistryResponse> {
  return getJson<RemediationRegistryResponse>('/api/remediation/registry');
}

// The resolved principal (issue #96): the SPA reads this to decide whether to show
// the Admin-only arm/disarm panel. The server is still the real gate on every write.
export function fetchAuthMe(): Promise<AuthMeResponse> {
  return getJson<AuthMeResponse>('/api/auth/me');
}

// Admin arm/disarm panel (issue #97). GET the current arm state + kill switch,
// PUT to set each. Admin-only on the server; a non-Admin PUT returns 403.
export function fetchArmState(): Promise<RemediationArmStateResponse> {
  return getJson<RemediationArmStateResponse>('/api/admin/arm-state');
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`request to ${url} responded ${res.status}`);
  }
  return (await res.json()) as T;
}

export function putArmState(armed: boolean): Promise<RemediationArmStateResponse> {
  return putJson<RemediationArmStateResponse>('/api/admin/arm-state', { armed });
}

export function putKillSwitch(killed: boolean): Promise<RemediationArmStateResponse> {
  return putJson<RemediationArmStateResponse>('/api/admin/kill-switch', { killed });
}

// Operator trigger. Fires ONLY on an explicit operator action in the modal. The
// backend is DISARMED by default (ADR-0010): with confirmed:true it fires the
// middleware's EXISTING authenticated endpoint when the path is armed, otherwise it
// returns a typed 'would_trigger' preview and makes no live call. `confirmed` is the
// per-action operator sign-off; the modal only sets it on the explicit second-step
// "Confirm and run" click.
export async function triggerRemediation(
  toolId: string,
  subject: { subjectKind: 'pipe' | 'signal' | 'order'; subjectKey: string } | null,
  confirmed: boolean,
  dryRun?: boolean,
  shopifyOrderId?: string | number,
  params?: Record<string, string | number>,
): Promise<RemediationTriggerResult> {
  const res = await fetch(`/api/remediation/${encodeURIComponent(toolId)}/trigger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // dryRun is sent only when specified: undefined keeps the safe server default
    // (dry_run true) on endpoints that support it. dryRun:false is the live apply
    // (Admin-only on the server); a non-Admin request for it returns 403.
    // shopifyOrderId is the NUMERIC Shopify id for order-targeted fixes (forward-sync
    // replay, recovery replay); the subjectKey for an order is the classification
    // signal, not the id, so the id must be threaded explicitly (fixes the 502).
    body: JSON.stringify({
      ...(subject ?? {}),
      confirmed,
      ...(dryRun === undefined ? {} : { dryRun }),
      ...(shopifyOrderId === undefined ? {} : { shopifyOrderId }),
      ...(params === undefined ? {} : { params }),
    }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed && typeof parsed.error === 'string') detail = `: ${parsed.error}`;
    } catch {
      // non-JSON body; fall through to the status-only message
    }
    throw new Error(`remediation trigger responded ${res.status}${detail}`);
  }
  return (await res.json()) as RemediationTriggerResult;
}

// The read-only diagnostic proxies (genuine_3pl_delay modal). The backend calls the
// middleware's existing read endpoints server-side and returns the JSON, so the
// browser never touches the middleware directly. Operator OR Admin.
export interface DiagnosticEnvelope {
  ok: boolean;
  source: string;
  data: unknown;
}

// GET /api/diagnostics/fulfillment-orders/:id -> the middleware FO Inspector.
export function fetchFulfillmentOrders(orderId: string): Promise<DiagnosticEnvelope> {
  return getJson<DiagnosticEnvelope>(
    `/api/diagnostics/fulfillment-orders/${encodeURIComponent(orderId)}`,
  );
}

// A normalized order line for the "Line items" DIAGNOSE read.
export interface OrderLineItem {
  sku: string;
  quantity: number;
  name: string;
}

// Richer order view for the universal Order panel (buildOrderInfo server-side).
export interface OrderInfoLine {
  sku: string;
  quantity: number;
  name: string;
  unit_price: string | null;
}
export interface OrderInfo {
  line_items: OrderInfoLine[];
  order_total: string | null;
  subtotal: string | null;
  currency: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
}

// Narrow an unknown diagnostic payload to OrderInfo, tolerating a missing body.
export function orderInfoFrom(data: unknown): OrderInfo | null {
  if (data === null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.line_items)) return null;
  const lines: OrderInfoLine[] = (d.line_items as unknown[]).map((li) => {
    const r = (li !== null && typeof li === 'object' ? li : {}) as Record<string, unknown>;
    return {
      sku: r.sku !== undefined && r.sku !== null ? String(r.sku) : '',
      quantity: Number.isFinite(Number(r.quantity)) ? Number(r.quantity) : 0,
      name: r.name !== undefined && r.name !== null ? String(r.name) : '',
      unit_price: r.unit_price !== undefined && r.unit_price !== null ? String(r.unit_price) : null,
    };
  });
  const s = (k: string): string | null => (d[k] !== undefined && d[k] !== null ? String(d[k]) : null);
  return {
    line_items: lines,
    order_total: s('order_total'),
    subtotal: s('subtotal'),
    currency: s('currency'),
    financial_status: s('financial_status'),
    fulfillment_status: s('fulfillment_status'),
  };
}

// One NAV IABC row: on-hand + available-to-ship for a SKU at a warehouse/channel.
export interface NavIabcRow {
  sku: string | null;
  location: string | null;
  channel: string | null;
  onHand: number | null;
  available: number | null;
  earliestShipDate: string | null;
}

// GET /api/diagnostics/nav-availability?sku= -> NAV IABC on-hand + available-to-ship
// across HF1FTZ (Holman) and TAC, per channel. NAV is the source of truth.
export function fetchNavAvailability(sku: string): Promise<{ sku: string; rows: NavIabcRow[] }> {
  return getJson<{ sku: string; rows: NavIabcRow[] }>(
    `/api/diagnostics/nav-availability?sku=${encodeURIComponent(sku)}`,
  );
}

// GET /api/diagnostics/shopify-order/:id -> the middleware Shopify order fetch,
// normalized server-side to { line_items: [{ sku, quantity, name }] }. Read-only.
// Lets an operator see the SKUs on a held order (the held-SKU field is often blank,
// especially for Not-in-NAV orders) and click a SKU to fill the Held SKU fix input.
export function fetchShopifyOrderLineItems(orderId: string): Promise<DiagnosticEnvelope> {
  return getJson<DiagnosticEnvelope>(
    `/api/diagnostics/shopify-order/${encodeURIComponent(orderId)}`,
  );
}

// GET /api/diagnostics/nav-inventory?sku=&location= -> the middleware NAV
// inventory availability check (read-only). location is optional.
export function fetchNavInventory(sku: string, location?: string): Promise<DiagnosticEnvelope> {
  const params = new URLSearchParams({ sku });
  if (location && location.length > 0) params.set('location', location);
  return getJson<DiagnosticEnvelope>(`/api/diagnostics/nav-inventory?${params.toString()}`);
}

// GET /api/diagnostics/inventory-sync-check?sku=&location=&channel= -> the
// inventory-sync per-SKU check (read-only dry run): NAV on-hand vs Shopify current
// vs would_set. Drives the reconcile Run and the Holman-release dry-run preview.
export function fetchInventorySyncCheck(
  sku: string,
  location?: string,
  channel?: string,
): Promise<DiagnosticEnvelope> {
  const params = new URLSearchParams({ sku });
  if (location && location.length > 0) params.set('location', location);
  if (channel && channel.length > 0) params.set('channel', channel);
  return getJson<DiagnosticEnvelope>(`/api/diagnostics/inventory-sync-check?${params.toString()}`);
}

// --- Unit 1 OOS-held DIAGNOSE reads (read-only proxies) --------------------
// The OOS-held modal loads these inline so the operator sees the cause without
// leaving the tool. Each proxies an existing middleware read (verified against the
// middleware main.rs route table); the backend attaches no password and mutates
// nothing. A failure degrades to the modal's "diagnostic unavailable" state.

// GET /api/diagnostics/job-queue-health -> NAV job-queue health (CU 50007/50009).
export function fetchJobQueueHealth(): Promise<DiagnosticEnvelope> {
  return getJson<DiagnosticEnvelope>('/api/diagnostics/job-queue-health');
}

// GET /api/diagnostics/order-presence/:id -> has this Shopify order reached NAV.
export function fetchOrderPresence(orderId: string): Promise<DiagnosticEnvelope> {
  return getJson<DiagnosticEnvelope>(
    `/api/diagnostics/order-presence/${encodeURIComponent(orderId)}`,
  );
}

// GET /api/diagnostics/pending-fulfillment-requests -> the pending back-sync queue.
export function fetchPendingFulfillment(): Promise<DiagnosticEnvelope> {
  return getJson<DiagnosticEnvelope>('/api/diagnostics/pending-fulfillment-requests');
}

// --- Comprehensive DIAGNOSE reads (the modal "Run diagnosis" buttons) ------
// Each proxies an existing middleware read (verified against main.rs) so a signal's
// DIAGNOSE button renders the live RESULT inline, never a raw endpoint string.

// GET /api/diagnostics/stuck-staging -> NAV staging rows stuck (Not Auto-released).
export function fetchStuckStaging(): Promise<DiagnosticEnvelope> {
  return getJson<DiagnosticEnvelope>('/api/diagnostics/stuck-staging');
}

// GET /api/diagnostics/stuck-staging-duplicates -> read-only preview of the
// duplicate staging rows a dedupe would delete (the dedupe stays held from live).
export function fetchStuckStagingDuplicates(): Promise<DiagnosticEnvelope> {
  return getJson<DiagnosticEnvelope>('/api/diagnostics/stuck-staging-duplicates');
}

// GET /api/diagnostics/missed-shipments -> NAV shipments with no Shopify fulfillment.
export function fetchMissedShipments(): Promise<DiagnosticEnvelope> {
  return getJson<DiagnosticEnvelope>('/api/diagnostics/missed-shipments');
}
