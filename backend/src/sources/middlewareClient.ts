// Read-only client for the Symmetry middleware's EXISTING HTTP endpoints.
//
// BOUNDARY: this is a pure external consumer. It only issues GET requests to
// observability endpoints the middleware ALREADY exposes (its dashboard.rs:
// dashboard activity/errors, inventory-sync/status, back-sync status +
// missed-shipments, price-sync/status, nav/job-queue/health, webhooks health,
// allocator/status). It never POSTs, never PUTs, never mutates, and adds NO new
// endpoint to the middleware. Every request is hardcoded to GET and routed
// through assertReadOnlyMethod as defence in depth. See design.md section 0.
//
// AUTH: per docs/DATA_SOURCES.md the dashboard.rs read endpoints are
// UNAUTHENTICATED observability surfaces (the middleware notes "no auth /
// password gates because these are observability surfaces"), so no token is
// normally required. An Authorization: Bearer header is sent ONLY when
// MIDDLEWARE_AUTH_TOKEN is set; it is never required and is absent by default.
//
// LIVE vs STUB: createMiddlewareClient() returns the live HTTP client when
// MIDDLEWARE_BASE_URL is configured, otherwise the stub. The live client fetches
// lazily (no request at import time) and, on any fetch/parse failure, degrades
// once to the stub's empty shape so verdicts fall back to 'unknown' and the app
// still boots when the middleware is unreachable.
import type { AllocationDecision, AllocationOutcome, Channel } from '@order-health/shared';
import type { MissedShipment } from '@order-health/shared';
import { config } from '../config';

// The middleware's inventory-sync status endpoint exposes the last dry-run's
// "would push" divergence (design.md 5A.2 / 5A.3). This is the ONLY signal the
// monitor takes from the middleware; watermark, walks and heartbeat come from NAV.
export interface InventorySyncStatus {
  dryRunWouldPush: number | null; // last dry-run "would push" count (the 7,245)
  dryRunAt: string | null;        // when that dry-run ran
  totalPairs: number | null;      // denominator (the 12,218)
}

// The middleware's allocator status endpoint (Unit 4) exposes the recent split
// decisions (warehouse_allocation_log) plus the window counts that drive the
// split-sanity signal. Read-only: this is the middleware's SQLite allocation log
// surfaced over an existing GET endpoint; we never write it.
export interface AllocatorStatus {
  lastDecisionAt: string | null;      // recency of the newest split decision
  serviceHeartbeatAt: string | null;  // allocator loop heartbeat
  windowSeconds: number | null;       // window the counts below cover
  decisionsWindow: number | null;     // total decisions in the window
  splitCount: number | null;          // multi-warehouse splits
  unallocatableCount: number | null;  // decisions with no ATP anywhere
  failedCount: number | null;         // errored decisions
  atpFallbackCount: number | null;    // inventory-aware fallbacks
  recentDecisions: AllocationDecision[]; // most-recent-first
}

// --- Unit 3 typed read shapes ---------------------------------------------
// nav_job_queue: the middleware ALREADY computes job-queue health (CU 50009
// auto-release + no-stuck-job tripwire). We CONSUME that verdict, we do not
// recompute it (design.md 6). This is the typed view of GET job-queue/health.
export interface JobQueueHealthStatus {
  verdict: string | null;            // the endpoint's OWN verdict string (adopted as-is)
  autoReleaseFiredAt: string | null; // last CU 50009 auto-release firing
  longestRunningJobS: number | null; // age of the oldest running Job Queue Entry
  stuckJobCount: number | null;      // jobs the middleware flags stuck (> its own threshold)
  checkedAt: string | null;          // when the middleware computed this
}

// price_sync: last-received (new price data flowing in) and last-run (syncer
// alive) recency, from the middleware's dashboard price_sync feed.
export interface PriceSyncStatus {
  lastReceivedAt: string | null; // newest price_sync row received
  lastRunAt: string | null;      // last price-sync run/loop completed
}

// shopify_webhook: last-received per topic plus each topic's subscription state
// (subscribed === false is the removed/absent-subscription WAF failure mode).
export interface WebhookTopicStatus {
  topic: string;
  lastReceivedAt: string | null;
  subscribed: boolean;
}
export interface ShopifyWebhookStatus {
  topics: WebhookTopicStatus[];
}

// Unit 2 (back-sync). The middleware's back-sync status endpoint exposes the
// back-sync watermark (last successful fulfillmentCreate), the back-sync watcher
// heartbeat, and the 24h fulfillment/error counters. These feed the freshness and
// liveness verdicts. Read-only.
export interface BackSyncStatus {
  lastBackSyncAt: string | null;      // watermark: last successful fulfillmentCreate
  watcherHeartbeatAt: string | null;  // back-sync watcher last loop
  fulfillmentsLast24h: number | null; // fulfillmentCreate calls sent in the last 24h
  errorsLast24h: number | null;       // back-sync errors in the last 24h
}

// Shapes are intentionally loose (Record) at the scaffold stage; Phase W units
// tighten each endpoint's response type as they wire it in.
export interface MiddlewareClient {
  // dashboard.rs activity/errors merge-sorted feed.
  getActivity(): Promise<Record<string, unknown>[]>;
  getErrors(): Promise<Record<string, unknown>[]>;
  // Already-computed verdict we CONSUME rather than recompute (design.md 6).
  getJobQueueHealth(): Promise<Record<string, unknown>>;
  getMissedShipments(): Promise<Record<string, unknown>[]>;
  getStuckStaging(): Promise<Record<string, unknown>[]>;
  getPendingFulfillment(): Promise<Record<string, unknown>[]>;
  // GET /api/inventory-sync/status (read-only): dry-run divergence numbers.
  getInventorySyncStatus(): Promise<InventorySyncStatus>;
  // GET /api/allocator/status (read-only): recent split decisions + window counts
  // for the Warehouse Split panel (Unit 4). Backed by the middleware SQLite
  // warehouse_allocation_log; the underlying read is SELECT-only, for example:
  //   SELECT decided_at, order_ref, channel, sku, qty, rule, location, outcome
  //     FROM warehouse_allocation_log
  //     WHERE decided_at >= :windowStart ORDER BY decided_at DESC
  // with the window aggregates (splits, unallocatable, failed, ATP fallbacks)
  // computed over the same window. No write path into the middleware (design.md 0).
  getAllocatorStatus(): Promise<AllocatorStatus>;
  // --- Unit 3 read-only endpoints ---
  // GET /api/nav/job-queue/health: the already-computed verdict we adopt.
  getJobQueueHealthStatus(): Promise<JobQueueHealthStatus>;
  // GET /api/price-sync/status (dashboard price_sync feed): last-received/last-run.
  getPriceSyncStatus(): Promise<PriceSyncStatus>;
  // GET /api/webhooks/shopify/health: last-received per topic + subscription state.
  getShopifyWebhookStatus(): Promise<ShopifyWebhookStatus>;
  // Unit 2. GET /api/back-sync/status (read-only): back-sync watermark, watcher
  // heartbeat, and 24h counters for the freshness and liveness verdicts.
  getBackSyncStatus(): Promise<BackSyncStatus>;
  // Unit 2. The EXISTING GET /api/back-sync/missed-shipments endpoint, typed. Each
  // row is a NAV shipment that posted with no shopify_fulfillment_id in
  // nav_shipment_sync (the fulfillmentCreate never fired). Returns null when the
  // endpoint has not been queried (stub) so the missed signal reads 'unknown'
  // rather than a false green. Wholesale shipments are excluded upstream.
  getMissedShipmentDetail(): Promise<MissedShipment[] | null>;
}

// ---------------------------------------------------------------------------
// GET-only paths. Every endpoint the client calls is listed here as a single
// source of truth. These are the middleware's EXISTING unauthenticated
// observability routes (dashboard.rs); this service ADDS none of them.
// ---------------------------------------------------------------------------
export const MIDDLEWARE_PATHS = {
  activity: '/api/dashboard/activity',
  errors: '/api/dashboard/errors',
  jobQueueHealth: '/api/nav/job-queue/health',
  missedShipments: '/api/back-sync/missed-shipments',
  stuckStaging: '/api/nav/stuck-staging',
  pendingFulfillment: '/api/fulfillment/pending',
  inventorySyncStatus: '/api/inventory-sync/status',
  allocatorStatus: '/api/allocator/status',
  priceSyncStatus: '/api/price-sync/status',
  shopifyWebhookHealth: '/api/webhooks/shopify/health',
  backSyncStatus: '/api/back-sync/status',
} as const;

// Default per-request timeout. The dashboard endpoints are cheap reads; a stalled
// middleware must degrade to 'unknown' quickly, never block the aggregator run.
export const MIDDLEWARE_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// PURE HELPERS (no I/O). These are the unit-tested surface: the URL/header
// builders and the per-endpoint mappers that turn a fake JSON body into the
// typed shape the interface declares. None of them touch fetch, so they run
// without a live middleware.
// ---------------------------------------------------------------------------

// A parsed JSON object is a loose bag of field -> value. Field naming on the wire
// is not yet confirmed (see PR: live validation pending), so mappers accept both
// camelCase and snake_case variants and coerce defensively.
export type Row = Record<string, unknown>;

// Read-only guard (HTTP analogue of the NAV client's assertReadOnly). The live
// client only ever constructs GET requests; this rejects anything else as
// defence in depth so no future edit can smuggle a mutating verb through.
export function assertReadOnlyMethod(method: string): void {
  if (method.toUpperCase() !== 'GET') {
    throw new Error(`middleware: refusing a non-GET request (read-only client): ${method}`);
  }
}

// Join base URL + path without doubling the slash. baseUrl may carry a trailing
// slash from the env; paths always start with '/'.
export function buildUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

// Build request headers. Accept JSON always; send Authorization: Bearer ONLY when
// a token is configured (the endpoints are unauthenticated, so it is usually
// absent). Never sends any other credential.
export function buildHeaders(authToken: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (authToken.length > 0) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  return headers;
}

// First non-null/undefined value among the candidate keys, else null.
function pick(row: Row, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v.toISOString();
  }
  if (typeof v === 'number') {
    // Epoch seconds or milliseconds. Values below ~10^12 are treated as seconds.
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

function toBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no') return false;
  }
  return fallback;
}

// Coerce a parsed JSON body to an array of records (tolerating a { items: [...] }
// or { rows: [...] } envelope). Non-array, non-envelope bodies yield [].
export function asRecordArray(body: unknown): Row[] {
  if (Array.isArray(body)) return body.filter((r): r is Row => typeof r === 'object' && r !== null);
  if (body !== null && typeof body === 'object') {
    for (const key of ['items', 'rows', 'data', 'results']) {
      const inner = (body as Row)[key];
      if (Array.isArray(inner)) {
        return inner.filter((r): r is Row => typeof r === 'object' && r !== null);
      }
    }
  }
  return [];
}

// Coerce a parsed JSON body to a single record.
export function asRecord(body: unknown): Row {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Row) : {};
}

// --- Per-endpoint mappers --------------------------------------------------

// GET /api/inventory-sync/status -> InventorySyncStatus (the dry-run divergence).
export function mapInventorySyncStatus(body: unknown): InventorySyncStatus {
  const r = asRecord(body);
  return {
    dryRunWouldPush: toNum(pick(r, 'dryRunWouldPush', 'dry_run_would_push', 'wouldPush', 'would_push')),
    dryRunAt: toIso(pick(r, 'dryRunAt', 'dry_run_at', 'dryRunRanAt', 'ranAt', 'at')),
    totalPairs: toNum(pick(r, 'totalPairs', 'total_pairs', 'pairs')),
  };
}

function mapChannel(v: unknown): Channel | null {
  const s = toStr(v);
  if (s === 'dtc' || s === 'wholesale') return s;
  return null;
}

const ALLOCATION_OUTCOMES: readonly AllocationOutcome[] = [
  'allocated',
  'split',
  'unallocatable',
  'failed',
];
function mapOutcome(v: unknown): AllocationOutcome {
  const s = toStr(v);
  return (ALLOCATION_OUTCOMES as readonly string[]).includes(s ?? '')
    ? (s as AllocationOutcome)
    : 'allocated'; // best-effort default for an unrecognised/absent outcome
}

// One warehouse_allocation_log row -> AllocationDecision.
export function mapAllocationDecision(row: Row): AllocationDecision {
  return {
    decided_at: toIso(pick(row, 'decided_at', 'decidedAt', 'at')),
    order_ref: toStr(pick(row, 'order_ref', 'orderRef', 'order')),
    channel: mapChannel(pick(row, 'channel')),
    sku: toStr(pick(row, 'sku', 'variant')),
    qty: toNum(pick(row, 'qty', 'quantity')),
    rule: toStr(pick(row, 'rule')),
    location: toStr(pick(row, 'location', 'warehouse')),
    outcome: mapOutcome(pick(row, 'outcome')),
  };
}

// GET /api/allocator/status -> AllocatorStatus (window counts + recent decisions).
export function mapAllocatorStatus(body: unknown): AllocatorStatus {
  const r = asRecord(body);
  const decisions = pick(r, 'recentDecisions', 'recent_decisions', 'decisions_list');
  return {
    lastDecisionAt: toIso(pick(r, 'lastDecisionAt', 'last_decision_at')),
    serviceHeartbeatAt: toIso(pick(r, 'serviceHeartbeatAt', 'service_heartbeat_at', 'heartbeatAt', 'heartbeat_at')),
    windowSeconds: toNum(pick(r, 'windowSeconds', 'window_seconds')),
    decisionsWindow: toNum(pick(r, 'decisionsWindow', 'decisions_window')),
    splitCount: toNum(pick(r, 'splitCount', 'split_count', 'splits')),
    unallocatableCount: toNum(pick(r, 'unallocatableCount', 'unallocatable_count', 'unallocatable')),
    failedCount: toNum(pick(r, 'failedCount', 'failed_count', 'failed')),
    atpFallbackCount: toNum(pick(r, 'atpFallbackCount', 'atp_fallback_count', 'atpFallbacks')),
    recentDecisions: Array.isArray(decisions)
      ? decisions.filter((d): d is Row => typeof d === 'object' && d !== null).map(mapAllocationDecision)
      : [],
  };
}

// GET /api/nav/job-queue/health -> JobQueueHealthStatus. verdict is ADOPTED
// unchanged (design.md 6); never recomputed here.
export function mapJobQueueHealthStatus(body: unknown): JobQueueHealthStatus {
  const r = asRecord(body);
  return {
    verdict: toStr(pick(r, 'verdict', 'status', 'health')),
    autoReleaseFiredAt: toIso(pick(r, 'autoReleaseFiredAt', 'auto_release_fired_at', 'autoReleaseAt')),
    longestRunningJobS: toNum(pick(r, 'longestRunningJobS', 'longest_running_job_s', 'longestRunningJobSeconds')),
    stuckJobCount: toNum(pick(r, 'stuckJobCount', 'stuck_job_count', 'stuckJobs')),
    checkedAt: toIso(pick(r, 'checkedAt', 'checked_at', 'at')),
  };
}

// GET /api/price-sync/status -> PriceSyncStatus (last-received + last-run).
export function mapPriceSyncStatus(body: unknown): PriceSyncStatus {
  const r = asRecord(body);
  return {
    lastReceivedAt: toIso(pick(r, 'lastReceivedAt', 'last_received_at', 'received_at')),
    lastRunAt: toIso(pick(r, 'lastRunAt', 'last_run_at', 'run_at')),
  };
}

// One topic row -> WebhookTopicStatus. subscribed defaults to true when absent:
// we cannot assert a subscription was REMOVED from missing data, and defaulting
// false would raise a false amber. The failure mode we detect is an EXPLICIT
// subscribed: false.
export function mapWebhookTopic(row: Row): WebhookTopicStatus {
  return {
    topic: toStr(pick(row, 'topic', 'name')) ?? '',
    lastReceivedAt: toIso(pick(row, 'lastReceivedAt', 'last_received_at', 'received_at')),
    subscribed: toBool(pick(row, 'subscribed', 'isSubscribed', 'is_subscribed'), true),
  };
}

// GET /api/webhooks/shopify/health -> ShopifyWebhookStatus. Accepts a bare array
// of topics or a { topics: [...] } envelope.
export function mapShopifyWebhookStatus(body: unknown): ShopifyWebhookStatus {
  let topicRows: Row[];
  if (Array.isArray(body)) {
    topicRows = body.filter((t): t is Row => typeof t === 'object' && t !== null);
  } else {
    const r = asRecord(body);
    const topics = pick(r, 'topics', 'subscriptions');
    topicRows = Array.isArray(topics)
      ? topics.filter((t): t is Row => typeof t === 'object' && t !== null)
      : [];
  }
  return { topics: topicRows.map(mapWebhookTopic) };
}

// GET /api/back-sync/status -> BackSyncStatus (watermark + heartbeat + 24h counts).
export function mapBackSyncStatus(body: unknown): BackSyncStatus {
  const r = asRecord(body);
  return {
    lastBackSyncAt: toIso(pick(r, 'lastBackSyncAt', 'last_back_sync_at')),
    watcherHeartbeatAt: toIso(pick(r, 'watcherHeartbeatAt', 'watcher_heartbeat_at', 'heartbeatAt', 'heartbeat_at')),
    fulfillmentsLast24h: toNum(pick(r, 'fulfillmentsLast24h', 'fulfillments_last_24h')),
    errorsLast24h: toNum(pick(r, 'errorsLast24h', 'errors_last_24h')),
  };
}

// One missed-shipments row -> MissedShipment.
export function mapMissedShipment(row: Row): MissedShipment {
  return {
    order_ref: toStr(pick(row, 'order_ref', 'orderRef', 'order')),
    web_id: toStr(pick(row, 'web_id', 'webId')),
    nav_shipment_no: toStr(pick(row, 'nav_shipment_no', 'navShipmentNo', 'shipmentNo')),
    carrier: toStr(pick(row, 'carrier')),
    tracking: toStr(pick(row, 'tracking')),
    posted_at: toIso(pick(row, 'posted_at', 'postedAt')),
    age_s: toNum(pick(row, 'age_s', 'ageS', 'ageSeconds')),
    reason: toStr(pick(row, 'reason', 'note')),
  };
}

// GET /api/back-sync/missed-shipments -> MissedShipment[]. An empty array is a
// legitimate "zero missed" (green); only a failed fetch degrades to null so the
// signal reads 'unknown' rather than a false green (see the live client).
export function mapMissedShipments(body: unknown): MissedShipment[] {
  return asRecordArray(body).map(mapMissedShipment);
}

// ---------------------------------------------------------------------------
// STUB (kept forever). Returned when the middleware is not configured, and the
// fallback the live client degrades to when the middleware is unreachable so the
// app still boots and verdicts fall back to 'unknown'.
// ---------------------------------------------------------------------------
export class MiddlewareClientStub implements MiddlewareClient {
  private note(endpoint: string): void {
    // eslint-disable-next-line no-console
    console.info(`[middleware:stub] ${endpoint} not called (middleware not configured / unreachable)`);
  }
  async getActivity(): Promise<Record<string, unknown>[]> {
    this.note(MIDDLEWARE_PATHS.activity);
    return [];
  }
  async getErrors(): Promise<Record<string, unknown>[]> {
    this.note(MIDDLEWARE_PATHS.errors);
    return [];
  }
  async getJobQueueHealth(): Promise<Record<string, unknown>> {
    this.note(MIDDLEWARE_PATHS.jobQueueHealth);
    return {};
  }
  async getMissedShipments(): Promise<Record<string, unknown>[]> {
    this.note(MIDDLEWARE_PATHS.missedShipments);
    return [];
  }
  async getStuckStaging(): Promise<Record<string, unknown>[]> {
    this.note(MIDDLEWARE_PATHS.stuckStaging);
    return [];
  }
  async getPendingFulfillment(): Promise<Record<string, unknown>[]> {
    this.note(MIDDLEWARE_PATHS.pendingFulfillment);
    return [];
  }
  async getInventorySyncStatus(): Promise<InventorySyncStatus> {
    this.note(MIDDLEWARE_PATHS.inventorySyncStatus);
    return { dryRunWouldPush: null, dryRunAt: null, totalPairs: null };
  }
  async getAllocatorStatus(): Promise<AllocatorStatus> {
    this.note(MIDDLEWARE_PATHS.allocatorStatus);
    return {
      lastDecisionAt: null,
      serviceHeartbeatAt: null,
      windowSeconds: null,
      decisionsWindow: null,
      splitCount: null,
      unallocatableCount: null,
      failedCount: null,
      atpFallbackCount: null,
      recentDecisions: [],
    };
  }
  async getJobQueueHealthStatus(): Promise<JobQueueHealthStatus> {
    // Real read-only shape: GET /api/nav/job-queue/health returns the middleware's
    // own {verdict, autoReleaseFiredAt, longestRunningJobS, stuckJobCount,
    // checkedAt}. We ADOPT verdict unchanged (design.md 6), never recompute it.
    this.note(MIDDLEWARE_PATHS.jobQueueHealth);
    return {
      verdict: null,
      autoReleaseFiredAt: null,
      longestRunningJobS: null,
      stuckJobCount: null,
      checkedAt: null,
    };
  }
  async getPriceSyncStatus(): Promise<PriceSyncStatus> {
    // Real read-only shape: newest dashboard price_sync row (last-received) and
    // the price-sync run/loop timestamp (last-run). GET-only.
    this.note(MIDDLEWARE_PATHS.priceSyncStatus);
    return { lastReceivedAt: null, lastRunAt: null };
  }
  async getShopifyWebhookStatus(): Promise<ShopifyWebhookStatus> {
    // Real read-only shape: last shopify_webhook_event per topic joined to the
    // live webhook subscription list (subscribed=false => removed subscription).
    this.note(MIDDLEWARE_PATHS.shopifyWebhookHealth);
    return { topics: [] };
  }
  async getBackSyncStatus(): Promise<BackSyncStatus> {
    this.note(MIDDLEWARE_PATHS.backSyncStatus);
    return {
      lastBackSyncAt: null,
      watcherHeartbeatAt: null,
      fulfillmentsLast24h: null,
      errorsLast24h: null,
    };
  }
  async getMissedShipmentDetail(): Promise<MissedShipment[] | null> {
    this.note(MIDDLEWARE_PATHS.missedShipments);
    // null (not empty) so the missed-shipments signal reads 'unknown' until the
    // endpoint is live; an empty array would falsely read as green (zero missed).
    return null;
  }
}

// ---------------------------------------------------------------------------
// LIVE client. Issues read-only GETs to the middleware's existing dashboard.rs
// endpoints with global fetch (Node 22+). Each request has an AbortController
// timeout; on any fetch/parse/non-2xx failure it logs once and degrades to the
// stub's empty shape (verdicts become 'unknown'), so an unreachable middleware
// never crashes the app or blocks boot. No request is made at import time.
// ---------------------------------------------------------------------------
class MiddlewareClientLive implements MiddlewareClient {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly stub = new MiddlewareClientStub();
  private degraded = false;

  constructor(mw: typeof config.middleware) {
    this.baseUrl = mw.baseUrl;
    this.authToken = mw.authToken;
  }

  // Issue one read-only GET and return the parsed JSON body. GET is hardcoded and
  // re-asserted; a non-2xx response or a network/timeout error throws to the
  // caller's degrade path.
  private async getJson(path: string): Promise<unknown> {
    const method = 'GET';
    assertReadOnlyMethod(method);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MIDDLEWARE_TIMEOUT_MS);
    try {
      const res = await fetch(buildUrl(this.baseUrl, path), {
        method,
        headers: buildHeaders(this.authToken),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`GET ${path} -> HTTP ${res.status}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Degrade helper: log the failure once and return the stub's fallback value.
  private degrade<T>(what: string, err: unknown, fallback: T): T {
    if (!this.degraded) {
      this.degraded = true;
      // eslint-disable-next-line no-console
      console.warn(`[middleware:live] ${what} failed; degrading to stub (unknown): ${String(err)}`);
    }
    return fallback;
  }

  async getActivity(): Promise<Record<string, unknown>[]> {
    try {
      return asRecordArray(await this.getJson(MIDDLEWARE_PATHS.activity));
    } catch (err) {
      return this.degrade('dashboard activity', err, this.stub.getActivity());
    }
  }

  async getErrors(): Promise<Record<string, unknown>[]> {
    try {
      return asRecordArray(await this.getJson(MIDDLEWARE_PATHS.errors));
    } catch (err) {
      return this.degrade('dashboard errors', err, this.stub.getErrors());
    }
  }

  async getJobQueueHealth(): Promise<Record<string, unknown>> {
    try {
      return asRecord(await this.getJson(MIDDLEWARE_PATHS.jobQueueHealth));
    } catch (err) {
      return this.degrade('job-queue health (raw)', err, this.stub.getJobQueueHealth());
    }
  }

  async getMissedShipments(): Promise<Record<string, unknown>[]> {
    try {
      return asRecordArray(await this.getJson(MIDDLEWARE_PATHS.missedShipments));
    } catch (err) {
      return this.degrade('missed shipments (raw)', err, this.stub.getMissedShipments());
    }
  }

  async getStuckStaging(): Promise<Record<string, unknown>[]> {
    try {
      return asRecordArray(await this.getJson(MIDDLEWARE_PATHS.stuckStaging));
    } catch (err) {
      return this.degrade('stuck staging', err, this.stub.getStuckStaging());
    }
  }

  async getPendingFulfillment(): Promise<Record<string, unknown>[]> {
    try {
      return asRecordArray(await this.getJson(MIDDLEWARE_PATHS.pendingFulfillment));
    } catch (err) {
      return this.degrade('pending fulfillment', err, this.stub.getPendingFulfillment());
    }
  }

  async getInventorySyncStatus(): Promise<InventorySyncStatus> {
    try {
      return mapInventorySyncStatus(await this.getJson(MIDDLEWARE_PATHS.inventorySyncStatus));
    } catch (err) {
      return this.degrade('inventory-sync status', err, this.stub.getInventorySyncStatus());
    }
  }

  async getAllocatorStatus(): Promise<AllocatorStatus> {
    try {
      return mapAllocatorStatus(await this.getJson(MIDDLEWARE_PATHS.allocatorStatus));
    } catch (err) {
      return this.degrade('allocator status', err, this.stub.getAllocatorStatus());
    }
  }

  async getJobQueueHealthStatus(): Promise<JobQueueHealthStatus> {
    try {
      return mapJobQueueHealthStatus(await this.getJson(MIDDLEWARE_PATHS.jobQueueHealth));
    } catch (err) {
      return this.degrade('job-queue health status', err, this.stub.getJobQueueHealthStatus());
    }
  }

  async getPriceSyncStatus(): Promise<PriceSyncStatus> {
    try {
      return mapPriceSyncStatus(await this.getJson(MIDDLEWARE_PATHS.priceSyncStatus));
    } catch (err) {
      return this.degrade('price-sync status', err, this.stub.getPriceSyncStatus());
    }
  }

  async getShopifyWebhookStatus(): Promise<ShopifyWebhookStatus> {
    try {
      return mapShopifyWebhookStatus(await this.getJson(MIDDLEWARE_PATHS.shopifyWebhookHealth));
    } catch (err) {
      return this.degrade('shopify webhook health', err, this.stub.getShopifyWebhookStatus());
    }
  }

  async getBackSyncStatus(): Promise<BackSyncStatus> {
    try {
      return mapBackSyncStatus(await this.getJson(MIDDLEWARE_PATHS.backSyncStatus));
    } catch (err) {
      return this.degrade('back-sync status', err, this.stub.getBackSyncStatus());
    }
  }

  async getMissedShipmentDetail(): Promise<MissedShipment[] | null> {
    try {
      // A successful GET (even an empty array) is a real "zero missed" reading;
      // only a failure degrades to null so the signal reads 'unknown'.
      return mapMissedShipments(await this.getJson(MIDDLEWARE_PATHS.missedShipments));
    } catch (err) {
      return this.degrade('missed-shipment detail', err, this.stub.getMissedShipmentDetail());
    }
  }
}

// Factory. Returns the REAL read-only HTTP client when MIDDLEWARE_BASE_URL is set;
// otherwise, and whenever the middleware is unreachable at request time, the stub
// answers so the app boots and verdicts fall back to 'unknown' rather than
// crashing. The live client fetches lazily on first call, never at import time.
export function createMiddlewareClient(): MiddlewareClient {
  const configured = config.middleware.baseUrl.length > 0;
  if (!configured) {
    // eslint-disable-next-line no-console
    console.info('[middleware] no MIDDLEWARE_BASE_URL configured; using read-only stub client');
    return new MiddlewareClientStub();
  }
  // eslint-disable-next-line no-console
  console.info(
    `[middleware] live read-only HTTP client active (baseUrl=${config.middleware.baseUrl}, ` +
      `auth=${config.middleware.authToken.length > 0 ? 'bearer-token' : 'none (unauthenticated)'})`,
  );
  return new MiddlewareClientLive(config.middleware);
}
