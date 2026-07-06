// Read-only client for the Symmetry middleware's EXISTING HTTP endpoints.
//
// BOUNDARY: this is a pure external consumer. It only issues GET requests to
// observability endpoints the middleware ALREADY exposes (its warp route table
// in main.rs / dashboard.rs / nav / shopify / warehouse_split handlers). It
// never POSTs, never PUTs, never mutates, and adds NO new endpoint to the
// middleware. Every request is hardcoded to GET and routed through
// assertReadOnlyMethod as defence in depth. See design.md section 0.
//
// REAL ROUTES (reconciled against the middleware repo — see
// docs/middleware-api-reconciliation.md and issues #36 / #37). The middleware is
// a warp server over SQLite that exposes per-source feeds/recents/analytics, NOT
// one "status" object per pipe. Two classes of fix are applied here:
//   * Issue #36 — direct path remaps (activity, errors, pending-fulfillment) and
//     response-shape corrections for the confirm-shape endpoints (job-queue
//     health, missed-shipments).
//   * Issue #37 — five per-pipe tiles have no 1:1 status endpoint; each is
//     COMPOSED read-only from the real feeds/recents/analytics. Where a datum is
//     genuinely not obtainable read-only over GET (e.g. the inventory dry-run
//     preview, allocator failed/atp-fallback counts, watcher/allocator
//     heartbeats) the field is left null so the tile reads 'unknown' — never a
//     false green — and the gap is documented on issue #37.
//
// AUTH: per docs/DATA_SOURCES.md these read endpoints are UNAUTHENTICATED
// observability surfaces ("no auth / password gates because these are
// observability surfaces"), so no token is normally required. An Authorization:
// Bearer header is sent ONLY when MIDDLEWARE_AUTH_TOKEN is set; it is never
// required and is absent by default.
//
// LIVE vs STUB: createMiddlewareClient() returns the live HTTP client when
// MIDDLEWARE_BASE_URL is configured, otherwise the stub. The live client fetches
// lazily (no request at import time) and, on any fetch/parse failure, degrades
// once to the stub's empty shape so verdicts fall back to 'unknown' and the app
// still boots when the middleware is unreachable.
import type { AllocationDecision, AllocationOutcome, Channel } from '@order-health/shared';
import type { MissedShipment } from '@order-health/shared';
import { config } from '../config';

// Composed from the inventory-sync analytics endpoint's last completed catalog
// walk (design.md 5A.2 / 5A.3). NOTE: the dry-run "would push" PREVIEW is only
// produced by POST /api/nav/inventory-sync/dry-run (async) + GET
// /dry-run/:id — there is no read-only GET for the latest dry-run, so
// dryRunWouldPush / dryRunAt stay null here (honest 'unknown'). totalPairs is the
// real catalog pair count from the last walk. See issue #37.
export interface InventorySyncStatus {
  dryRunWouldPush: number | null; // last dry-run "would push" count — NOT read-only (null)
  dryRunAt: string | null;        // when that dry-run ran — NOT read-only (null)
  totalPairs: number | null;      // denominator (the 12,218) from analytics.cron.last_walk
}

// Composed from GET /api/warehouse/rollout/audit (the warehouse_allocation_log
// recent page) plus GET /api/oos-held. Read-only: these are the middleware's
// SQLite allocation log + OOS-held backlog surfaced over existing GET endpoints;
// we never write them. Several counts are NOT obtainable read-only (see issue
// #37) and stay null: failedCount (the log has no failed/error outcome column),
// atpFallbackCount (no distinct fallback reason code exposed) and
// serviceHeartbeatAt (no allocator loop heartbeat endpoint).
export interface AllocatorStatus {
  lastDecisionAt: string | null;      // recency of the newest split decision
  serviceHeartbeatAt: string | null;  // allocator loop heartbeat — NOT exposed (null)
  windowSeconds: number | null;       // wall-clock span the returned sample covers
  decisionsWindow: number | null;     // decisions in the returned audit sample
  splitCount: number | null;          // multi-warehouse splits in that sample
  unallocatableCount: number | null;  // OOS-held backlog (order-level) from /api/oos-held
  failedCount: number | null;         // errored decisions — NOT exposed (null)
  atpFallbackCount: number | null;    // inventory-aware fallbacks — NOT exposed (null)
  recentDecisions: AllocationDecision[]; // most-recent-first
}

// --- Unit 3 typed read shapes ---------------------------------------------
// nav_job_queue: the middleware ALREADY computes job-queue health (CU 50009
// auto-release + no-stuck-job tripwire). We CONSUME that verdict, we do not
// recompute it (design.md 6). This is the typed view of GET
// /api/nav/job-queue/health, whose real body is
// { level, summary, last_auto_release, pending_staging, stuck_jobs[], queried_at }.
export interface JobQueueHealthStatus {
  verdict: string | null;            // the endpoint's OWN `level` string (adopted as-is)
  autoReleaseFiredAt: string | null; // last CU 50009 auto-release firing (`last_auto_release`)
  longestRunningJobS: number | null; // max stuck_jobs[].minutes_stuck, in seconds
  stuckJobCount: number | null;      // stuck_jobs.length
  checkedAt: string | null;          // when the middleware computed this (`queried_at`)
}

// price_sync: last-received (newest price_sync row) from
// GET /api/nav/price-sync/recent, and last-run (syncer loop alive) from
// GET /api/nav/price-sync/settings `last_run_at`.
export interface PriceSyncStatus {
  lastReceivedAt: string | null; // newest price_sync row received
  lastRunAt: string | null;      // last price-sync run/loop completed
}

// shopify_webhook: last-received per topic (from GET /api/shopify/webhooks/events)
// plus each topic's subscription state (from GET /api/shopify/webhooks/subscriptions;
// subscribed === false is the removed/absent-subscription WAF failure mode).
export interface WebhookTopicStatus {
  topic: string;
  lastReceivedAt: string | null;
  subscribed: boolean;
}
export interface ShopifyWebhookStatus {
  topics: WebhookTopicStatus[];
}

// Unit 2 (back-sync). Composed from GET /api/nav/back-sync/feed. The watermark
// (lastBackSyncAt) is the newest feed row that carries a shopify_fulfillment_id;
// the 24h counters are derived from the returned feed window. The back-sync
// WATCHER heartbeat is not exposed read-only, so watcherHeartbeatAt stays null
// (see issue #37).
export interface BackSyncStatus {
  lastBackSyncAt: string | null;      // watermark: newest row with a shopify_fulfillment_id
  watcherHeartbeatAt: string | null;  // back-sync watcher last loop — NOT exposed (null)
  fulfillmentsLast24h: number | null; // feed rows w/ fulfillment_id recorded in last 24h
  errorsLast24h: number | null;       // feed rows w/ error recorded in last 24h
}

// Shapes are intentionally loose (Record) at the scaffold stage; Phase W units
// tighten each endpoint's response type as they wire it in.
export interface MiddlewareClient {
  // GET /api/activity/recent — merge-sorted ActivityItem[] feed.
  getActivity(): Promise<Record<string, unknown>[]>;
  // GET /api/errors — { days, page, page_size, total, rows: ActivityItem[] }.
  getErrors(): Promise<Record<string, unknown>[]>;
  // Already-computed verdict we CONSUME rather than recompute (design.md 6).
  getJobQueueHealth(): Promise<Record<string, unknown>>;
  getMissedShipments(): Promise<Record<string, unknown>[]>;
  getStuckStaging(): Promise<Record<string, unknown>[]>;
  getPendingFulfillment(): Promise<Record<string, unknown>[]>;
  // Composed from GET /api/nav/inventory-sync/analytics (last-walk pair count).
  getInventorySyncStatus(): Promise<InventorySyncStatus>;
  // Composed from GET /api/warehouse/rollout/audit + GET /api/oos-held.
  getAllocatorStatus(): Promise<AllocatorStatus>;
  // --- Unit 3 read-only endpoints ---
  // GET /api/nav/job-queue/health: the already-computed verdict we adopt.
  getJobQueueHealthStatus(): Promise<JobQueueHealthStatus>;
  // Composed from GET /api/nav/price-sync/recent + /settings.
  getPriceSyncStatus(): Promise<PriceSyncStatus>;
  // Composed from GET /api/shopify/webhooks/subscriptions + /events.
  getShopifyWebhookStatus(): Promise<ShopifyWebhookStatus>;
  // Unit 2. Composed from GET /api/nav/back-sync/feed.
  getBackSyncStatus(): Promise<BackSyncStatus>;
  // Unit 2. The EXISTING GET /api/back-sync/missed-shipments endpoint, typed. Each
  // row is a NAV shipment that posted with no shopify_fulfillment_id (the
  // fulfillmentCreate never fired). Returns null when the endpoint has not been
  // queried (stub) / failed so the missed signal reads 'unknown' rather than a
  // false green. Wholesale shipments are excluded upstream.
  getMissedShipmentDetail(): Promise<MissedShipment[] | null>;
}

// ---------------------------------------------------------------------------
// GET-only paths. Every endpoint the client calls is listed here as a single
// source of truth. These are the middleware's EXISTING unauthenticated
// observability routes; this service ADDS none of them. Paths reconciled against
// the middleware warp route table (main.rs) — see issues #36 / #37.
// ---------------------------------------------------------------------------
export const MIDDLEWARE_PATHS = {
  // Issue #36 — direct routes (corrected paths).
  activity: '/api/activity/recent',
  errors: '/api/errors',
  errorsCount: '/api/errors/count',
  jobQueueHealth: '/api/nav/job-queue/health',
  missedShipments: '/api/back-sync/missed-shipments',
  stuckStaging: '/api/nav/stuck-staging',
  pendingFulfillment: '/api/middleware/pending-fulfillment-requests',
  // Issue #37 — compose sources (the single per-pipe status endpoints the client
  // originally assumed do NOT exist; each tile is composed from these).
  backSyncFeed: '/api/nav/back-sync/feed',
  inventorySyncAnalytics: '/api/nav/inventory-sync/analytics',
  priceSyncRecent: '/api/nav/price-sync/recent',
  priceSyncSettings: '/api/nav/price-sync/settings',
  webhookSubscriptions: '/api/shopify/webhooks/subscriptions',
  webhookEvents: '/api/shopify/webhooks/events',
  allocatorAudit: '/api/warehouse/rollout/audit',
  oosHeld: '/api/oos-held',
} as const;

// Default per-request timeout. The dashboard endpoints are cheap reads; a stalled
// middleware must degrade to 'unknown' quickly, never block the aggregator run.
export const MIDDLEWARE_TIMEOUT_MS = 5000;

// How many rows to pull from the feed / audit endpoints when composing a tile.
// The 24h back-sync counters and allocator split-sample are bounded by this
// window; a healthy install has far fewer rows than this in any 24h window.
export const MIDDLEWARE_FEED_LIMIT = 200;

// ---------------------------------------------------------------------------
// PURE HELPERS (no I/O). These are the unit-tested surface: the URL/header
// builders and the per-endpoint mappers that turn a fake JSON body into the
// typed shape the interface declares. None of them touch fetch, so they run
// without a live middleware.
// ---------------------------------------------------------------------------

// A parsed JSON object is a loose bag of field -> value. Field naming on the wire
// is confirmed against the middleware handlers; mappers still accept both
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

// Append a query string to a path (skipping undefined values). Keeps GET-only
// query construction in one place.
export function buildPath(path: string, params?: Record<string, string | number | undefined>): string {
  if (!params) return path;
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs.length > 0 ? `${path}?${qs}` : path;
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

// ---------------------------------------------------------------------------
// Body coercion. asRecordArray tolerates a bare array or any of the envelope
// keys the middleware handlers actually use: `rows` (errors, stuck-staging,
// price-sync recent, allocator audit), `missed` (missed-shipments), `pending`
// (pending-fulfillment), `events` (webhook events), plus generic items/data.
// ---------------------------------------------------------------------------
const ENVELOPE_KEYS = ['items', 'rows', 'data', 'results', 'missed', 'pending', 'events'] as const;

export function asRecordArray(body: unknown): Row[] {
  if (Array.isArray(body)) return body.filter((r): r is Row => typeof r === 'object' && r !== null);
  if (body !== null && typeof body === 'object') {
    for (const key of ENVELOPE_KEYS) {
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

// Newest ISO timestamp among a set of rows for a given set of candidate keys.
function newestTimestamp(rows: Row[], ...keys: string[]): string | null {
  let newest: string | null = null;
  for (const row of rows) {
    const t = toIso(pick(row, ...keys));
    if (t !== null && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

// --- Per-endpoint mappers --------------------------------------------------

// GET /api/nav/inventory-sync/analytics -> InventorySyncStatus. The analytics
// body flattens InventorySyncAnalytics and adds a `cron` object whose `last_walk`
// is the last completed catalog walk's progress JSON
// ({ total_pairs, pushed, completed_at, ... }). That walk is the only READ-ONLY
// surface for the pair count. The dry-run "would push" preview is POST-triggered
// with no read-only GET, so dryRunWouldPush / dryRunAt stay null unless a body
// explicitly carries them (kept for forward-compat / defensiveness).
export function mapInventorySyncStatus(body: unknown): InventorySyncStatus {
  const r = asRecord(body);
  const cron = asRecord(pick(r, 'cron'));
  const lastWalk = asRecord(pick(cron, 'last_walk', 'lastWalk'));
  return {
    dryRunWouldPush: toNum(pick(r, 'dryRunWouldPush', 'dry_run_would_push', 'wouldPush', 'would_push')),
    dryRunAt: toIso(pick(r, 'dryRunAt', 'dry_run_at', 'dryRunRanAt', 'ranAt')),
    totalPairs:
      toNum(pick(lastWalk, 'total_pairs', 'totalPairs')) ??
      toNum(pick(r, 'totalPairs', 'total_pairs', 'pairs')),
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

// One warehouse_allocation_log row (from /api/warehouse/rollout/audit) ->
// AllocationDecision. The log row has no `outcome`/`qty`/`channel` columns; its
// `reason` is the applied rule (rolled / stock_asymmetry / out_of_stock / ...)
// and `warehouse_assigned` the resolved warehouse. A row whose reason is
// out_of_stock is surfaced as an unallocatable outcome.
export function mapAllocationDecision(row: Row): AllocationDecision {
  const rule = toStr(pick(row, 'rule', 'reason'));
  const explicitOutcome = pick(row, 'outcome');
  const derivedOutcome = explicitOutcome ?? (rule === 'out_of_stock' ? 'unallocatable' : null);
  return {
    decided_at: toIso(pick(row, 'decided_at', 'decidedAt', 'at')),
    order_ref: toStr(pick(row, 'order_ref', 'orderRef', 'order', 'order_id')),
    channel: mapChannel(pick(row, 'channel')),
    sku: toStr(pick(row, 'sku', 'variant')),
    qty: toNum(pick(row, 'qty', 'quantity')),
    rule,
    location: toStr(pick(row, 'location', 'warehouse', 'warehouse_assigned', 'nav_location_code')),
    outcome: mapOutcome(derivedOutcome),
  };
}

// GET /api/warehouse/rollout/audit + GET /api/oos-held -> AllocatorStatus.
//   * audit body: { rows: WarehouseAllocationRow[] (decided_at DESC), total }
//   * oos-held body: OosHeldOrderRow[] (bare array)
// The audit page is treated as the sample window: windowSeconds is the wall-clock
// span between the oldest and newest decided_at in the page, decisionsWindow is
// the row count, and splitCount is the number of orders whose lines span >1
// warehouse in the page. unallocatableCount is the current OOS-held backlog.
// failedCount / atpFallbackCount / serviceHeartbeatAt are NOT obtainable
// read-only (no failed/error outcome column, no distinct atp-fallback reason
// code, no allocator heartbeat endpoint) and stay null. See issue #37.
export function mapAllocatorStatus(auditBody: unknown, oosHeldBody: unknown): AllocatorStatus {
  const rows = asRecordArray(auditBody);
  const decisions = rows.map(mapAllocationDecision);

  // Sample window bounds from decided_at.
  let newest: string | null = null;
  let oldest: string | null = null;
  for (const d of decisions) {
    if (d.decided_at === null) continue;
    if (newest === null || d.decided_at > newest) newest = d.decided_at;
    if (oldest === null || d.decided_at < oldest) oldest = d.decided_at;
  }
  let windowSeconds: number | null = null;
  if (newest !== null && oldest !== null && newest !== oldest) {
    const span = (Date.parse(newest) - Date.parse(oldest)) / 1000;
    windowSeconds = Number.isFinite(span) && span > 0 ? Math.round(span) : null;
  }

  // Splits: orders whose lines were assigned to >1 distinct warehouse.
  const warehousesByOrder = new Map<string, Set<string>>();
  for (const row of rows) {
    const order = toStr(pick(row, 'order_id', 'order_ref', 'orderRef', 'order'));
    const wh = toStr(pick(row, 'warehouse_assigned', 'location', 'warehouse', 'nav_location_code'));
    if (order === null || wh === null) continue;
    let set = warehousesByOrder.get(order);
    if (set === undefined) {
      set = new Set<string>();
      warehousesByOrder.set(order, set);
    }
    set.add(wh);
  }
  let splitCount = 0;
  for (const set of warehousesByOrder.values()) {
    if (set.size > 1) splitCount += 1;
  }

  // unallocatable ≈ OOS-held backlog (order-level, current). A bare array (even
  // empty) is a real count; a non-array (degraded/failed body) leaves it null.
  const unallocatableCount = Array.isArray(oosHeldBody) ? asRecordArray(oosHeldBody).length : null;

  const hasRows = rows.length > 0;
  return {
    lastDecisionAt: newest,
    serviceHeartbeatAt: null,
    windowSeconds,
    decisionsWindow: hasRows ? rows.length : null,
    splitCount: hasRows ? splitCount : null,
    unallocatableCount,
    failedCount: null,
    atpFallbackCount: null,
    recentDecisions: decisions,
  };
}

// GET /api/nav/job-queue/health -> JobQueueHealthStatus. The real body is
// { level, summary, last_auto_release, pending_staging, stuck_jobs[], queried_at }.
// `level` is ADOPTED unchanged as the verdict (design.md 6); never recomputed.
export function mapJobQueueHealthStatus(body: unknown): JobQueueHealthStatus {
  const r = asRecord(body);
  const stuckRaw = pick(r, 'stuck_jobs', 'stuckJobs');
  const jobs = Array.isArray(stuckRaw)
    ? stuckRaw.filter((j): j is Row => typeof j === 'object' && j !== null)
    : [];

  // longest running job = max stuck_jobs[].minutes_stuck, converted to seconds.
  let longestRunningJobS = toNum(pick(r, 'longestRunningJobS', 'longest_running_job_s', 'longestRunningJobSeconds'));
  if (longestRunningJobS === null && jobs.length > 0) {
    const mins = jobs
      .map((j) => toNum(pick(j, 'minutes_stuck', 'minutesStuck')))
      .filter((n): n is number => n !== null);
    if (mins.length > 0) longestRunningJobS = Math.max(...mins) * 60;
  }

  const explicitCount = toNum(pick(r, 'stuck_job_count', 'stuckJobCount'));
  const stuckJobCount = explicitCount !== null ? explicitCount : Array.isArray(stuckRaw) ? jobs.length : null;

  return {
    verdict: toStr(pick(r, 'level', 'verdict', 'status', 'health')),
    autoReleaseFiredAt: toIso(pick(r, 'last_auto_release', 'autoReleaseFiredAt', 'auto_release_fired_at', 'autoReleaseAt')),
    longestRunningJobS,
    stuckJobCount,
    checkedAt: toIso(pick(r, 'queried_at', 'checkedAt', 'checked_at', 'at')),
  };
}

// GET /api/nav/price-sync/recent (rows, synced_at DESC) + GET
// /api/nav/price-sync/settings (`last_run_at`) -> PriceSyncStatus. lastReceivedAt
// is the newest recorded price_sync row; lastRunAt is the syncer's last loop
// completion (which ticks even when a run pushes nothing — the true liveness).
export function mapPriceSyncStatus(recentBody: unknown, settingsBody: unknown): PriceSyncStatus {
  const rows = asRecordArray(recentBody);
  const settings = asRecord(settingsBody);
  return {
    lastReceivedAt: newestTimestamp(rows, 'synced_at', 'syncedAt', 'received_at', 'receivedAt'),
    lastRunAt: toIso(pick(settings, 'last_run_at', 'lastRunAt', 'last_received_at')),
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
    subscribed: pick(row, 'deactivated_at', 'deactivatedAt') === null,
  };
}

// GET /api/shopify/webhooks/subscriptions (bare ShopifyWebhookSubscription[],
// active when deactivated_at is null) + GET /api/shopify/webhooks/events
// ({ events: ShopifyWebhookEvent[], total }) -> ShopifyWebhookStatus. Each topic's
// last-received is the newest event received_at for that topic; subscribed comes
// from the subscription row. Topics seen in events but with no subscription row
// are surfaced as subscribed:false (the removed-subscription failure mode).
export function mapShopifyWebhookStatus(subscriptionsBody: unknown, eventsBody: unknown): ShopifyWebhookStatus {
  const subs = asRecordArray(subscriptionsBody);
  const events = asRecordArray(eventsBody);

  const lastByTopic = new Map<string, string>();
  for (const ev of events) {
    const topic = toStr(pick(ev, 'topic', 'name'));
    if (topic === null) continue;
    const t = toIso(pick(ev, 'received_at', 'receivedAt', 'triggered_at', 'lastReceivedAt', 'last_received_at'));
    if (t === null) continue;
    const prev = lastByTopic.get(topic);
    if (prev === undefined || t > prev) lastByTopic.set(topic, t);
  }

  const topics: WebhookTopicStatus[] = [];
  const seen = new Set<string>();
  for (const s of subs) {
    const topic = toStr(pick(s, 'topic', 'name'));
    if (topic === null || seen.has(topic)) continue;
    seen.add(topic);
    topics.push({
      topic,
      lastReceivedAt: lastByTopic.get(topic) ?? null,
      subscribed: pick(s, 'deactivated_at', 'deactivatedAt') === null,
    });
  }
  // Topics with traffic but no (active) subscription row -> removed subscription.
  for (const [topic, t] of lastByTopic) {
    if (seen.has(topic)) continue;
    seen.add(topic);
    topics.push({ topic, lastReceivedAt: t, subscribed: false });
  }
  return { topics };
}

// GET /api/nav/back-sync/feed -> BackSyncStatus. Feed rows are recorded_at DESC;
// each carries shopify_fulfillment_id (null = not yet back-synced) and an
// optional error. The watermark is the newest row WITH a fulfillment_id; the 24h
// counters are computed over the returned window (bounded by MIDDLEWARE_FEED_LIMIT).
// The watcher heartbeat is not exposed read-only, so watcherHeartbeatAt is null.
export function mapBackSyncStatus(body: unknown, now: number = Date.now()): BackSyncStatus {
  const rows = asRecordArray(body);
  const cutoff = now - 24 * 3600 * 1000;

  let lastBackSyncAt: string | null = null;
  let fulfillmentsLast24h = 0;
  let errorsLast24h = 0;
  for (const row of rows) {
    const hasFulfillment = pick(row, 'shopify_fulfillment_id', 'shopifyFulfillmentId') !== null;
    const recordedAt = toIso(pick(row, 'recorded_at', 'recordedAt', 'synced_at', 'posted_at'));
    const hasError = pick(row, 'error') !== null;

    if (hasFulfillment && recordedAt !== null && (lastBackSyncAt === null || recordedAt > lastBackSyncAt)) {
      lastBackSyncAt = recordedAt;
    }
    const ts = recordedAt !== null ? Date.parse(recordedAt) : NaN;
    if (!Number.isNaN(ts) && ts >= cutoff) {
      if (hasFulfillment) fulfillmentsLast24h += 1;
      if (hasError) errorsLast24h += 1;
    }
  }
  return {
    lastBackSyncAt,
    watcherHeartbeatAt: null,
    fulfillmentsLast24h,
    errorsLast24h,
  };
}

// One missed-shipments row (from /api/back-sync/missed-shipments) -> MissedShipment.
// The real row is { nav_shipment_no, sales_order, posting_date, tracking_no,
// shipping_agent, location_code, status, last_error }. web_id and age_s are not
// exposed by this endpoint and stay null.
export function mapMissedShipment(row: Row): MissedShipment {
  return {
    order_ref: toStr(pick(row, 'sales_order', 'order_ref', 'orderRef', 'order')),
    web_id: toStr(pick(row, 'web_id', 'webId')),
    nav_shipment_no: toStr(pick(row, 'nav_shipment_no', 'navShipmentNo', 'shipmentNo')),
    carrier: toStr(pick(row, 'shipping_agent', 'carrier')),
    tracking: toStr(pick(row, 'tracking_no', 'tracking')),
    posted_at: toIso(pick(row, 'posting_date', 'posted_at', 'postedAt')),
    age_s: toNum(pick(row, 'age_s', 'ageS', 'ageSeconds')),
    reason: toStr(pick(row, 'last_error', 'reason', 'note', 'status')),
  };
}

// GET /api/back-sync/missed-shipments -> MissedShipment[]. The endpoint wraps the
// rows in a `{ missed: [...] }` envelope (asRecordArray unwraps it). An empty
// array is a legitimate "zero missed" (green); only a failed fetch degrades to
// null so the signal reads 'unknown' rather than a false green (see live client).
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
    this.note(MIDDLEWARE_PATHS.inventorySyncAnalytics);
    return { dryRunWouldPush: null, dryRunAt: null, totalPairs: null };
  }
  async getAllocatorStatus(): Promise<AllocatorStatus> {
    this.note(MIDDLEWARE_PATHS.allocatorAudit);
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
    // own { level, summary, last_auto_release, pending_staging, stuck_jobs[],
    // queried_at }. We ADOPT `level` unchanged (design.md 6), never recompute it.
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
    // Composed read: newest price-sync row (last-received) + settings.last_run_at
    // (last-run). GET-only.
    this.note(MIDDLEWARE_PATHS.priceSyncRecent);
    return { lastReceivedAt: null, lastRunAt: null };
  }
  async getShopifyWebhookStatus(): Promise<ShopifyWebhookStatus> {
    // Composed read: last webhook event per topic joined to the live subscription
    // list (deactivated_at != null => removed subscription).
    this.note(MIDDLEWARE_PATHS.webhookSubscriptions);
    return { topics: [] };
  }
  async getBackSyncStatus(): Promise<BackSyncStatus> {
    this.note(MIDDLEWARE_PATHS.backSyncFeed);
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
// LIVE client. Issues read-only GETs to the middleware's existing endpoints with
// global fetch (Node 22+). Each request has an AbortController timeout; on any
// fetch/parse/non-2xx failure it logs once and degrades to the stub's empty shape
// (verdicts become 'unknown'), so an unreachable middleware never crashes the app
// or blocks boot. No request is made at import time.
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
      return asRecordArray(await this.getJson(buildPath(MIDDLEWARE_PATHS.activity, { limit: MIDDLEWARE_FEED_LIMIT })));
    } catch (err) {
      return this.degrade('activity feed', err, this.stub.getActivity());
    }
  }

  async getErrors(): Promise<Record<string, unknown>[]> {
    try {
      return asRecordArray(await this.getJson(MIDDLEWARE_PATHS.errors));
    } catch (err) {
      return this.degrade('errors view', err, this.stub.getErrors());
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
      return mapInventorySyncStatus(await this.getJson(MIDDLEWARE_PATHS.inventorySyncAnalytics));
    } catch (err) {
      return this.degrade('inventory-sync analytics', err, this.stub.getInventorySyncStatus());
    }
  }

  async getAllocatorStatus(): Promise<AllocatorStatus> {
    try {
      const [audit, oosHeld] = await Promise.all([
        this.getJson(buildPath(MIDDLEWARE_PATHS.allocatorAudit, { limit: MIDDLEWARE_FEED_LIMIT })),
        this.getJson(buildPath(MIDDLEWARE_PATHS.oosHeld, { limit: MIDDLEWARE_FEED_LIMIT })),
      ]);
      return mapAllocatorStatus(audit, oosHeld);
    } catch (err) {
      return this.degrade('allocator status (audit + oos-held)', err, this.stub.getAllocatorStatus());
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
      const [recent, settings] = await Promise.all([
        this.getJson(MIDDLEWARE_PATHS.priceSyncRecent),
        this.getJson(MIDDLEWARE_PATHS.priceSyncSettings),
      ]);
      return mapPriceSyncStatus(recent, settings);
    } catch (err) {
      return this.degrade('price-sync status (recent + settings)', err, this.stub.getPriceSyncStatus());
    }
  }

  async getShopifyWebhookStatus(): Promise<ShopifyWebhookStatus> {
    try {
      const [subs, events] = await Promise.all([
        this.getJson(MIDDLEWARE_PATHS.webhookSubscriptions),
        this.getJson(buildPath(MIDDLEWARE_PATHS.webhookEvents, { limit: MIDDLEWARE_FEED_LIMIT })),
      ]);
      return mapShopifyWebhookStatus(subs, events);
    } catch (err) {
      return this.degrade('shopify webhook status (subscriptions + events)', err, this.stub.getShopifyWebhookStatus());
    }
  }

  async getBackSyncStatus(): Promise<BackSyncStatus> {
    try {
      return mapBackSyncStatus(
        await this.getJson(buildPath(MIDDLEWARE_PATHS.backSyncFeed, { limit: MIDDLEWARE_FEED_LIMIT })),
      );
    } catch (err) {
      return this.degrade('back-sync status (feed)', err, this.stub.getBackSyncStatus());
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
