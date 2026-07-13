// Read-only client for the Symmetry middleware's EXISTING HTTP endpoints.
//
// BOUNDARY: this is a pure external consumer. It only issues GET requests to
// endpoints the middleware already exposes (dashboard activity/errors,
// job-queue/health, back-sync/missed-shipments, stuck-staging,
// pending-fulfillment). It never POSTs, never mutates, and adds nothing to the
// middleware. See design.md section 0.
//
// STUB STATUS: the interface below is the real contract Phase W will consume,
// but the implementation returns empty placeholder data because live source
// access is gated on DevOps provisioning (read-only token + base URL).
import type { AllocationDecision } from '@order-health/shared';
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
  splitCount: number | null;          // multi-warehouse splits IN THE WINDOW
  // Unit 4 (health-fidelity): WINDOW-scoped counts (decisions whose decided_at is
  // inside the window), NOT the standing backlog. Composed as, for example:
  //   SELECT COUNT(*) FILTER (WHERE outcome='unallocatable') AS unallocatable,
  //          COUNT(*) FILTER (WHERE outcome='failed')        AS failed
  //     FROM warehouse_allocation_log WHERE decided_at >= :windowStart
  unallocatableCount: number | null;  // in-window decisions with no ATP anywhere
  failedCount: number | null;         // in-window errored decisions
  atpFallbackCount: number | null;    // inventory-aware fallbacks
  // The STANDING OOS-held / needs-operator / backorder backlog, from a SEPARATE
  // (non-time-windowed) read over the held-orders view, for example:
  //   SELECT COUNT(*) AS held, MIN(first_seen_at) AS oldest
  //     FROM warehouse_allocation_log WHERE outcome IN ('unallocatable') AND held=1
  // Surfaced beside the rate as its own labelled count/age; never in failed_rate.
  oosHeldCount: number | null;        // orders currently held OOS / needs-operator / backorder
  oosHeldOldestAgeS: number | null;   // age of the oldest such held order (first-seen)
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

// Clearly-marked stub. Every method returns empty/placeholder data and logs a
// one-line note so it is obvious in logs that no live call was made.
class MiddlewareClientStub implements MiddlewareClient {
  private note(endpoint: string): void {
    // eslint-disable-next-line no-console
    console.info(`[middleware:stub] ${endpoint} not called (DevOps provisioning gated)`);
  }
  async getActivity(): Promise<Record<string, unknown>[]> {
    this.note('GET /api/dashboard/activity');
    return [];
  }
  async getErrors(): Promise<Record<string, unknown>[]> {
    this.note('GET /api/dashboard/errors');
    return [];
  }
  async getJobQueueHealth(): Promise<Record<string, unknown>> {
    this.note('GET /api/nav/job-queue/health');
    return {};
  }
  async getMissedShipments(): Promise<Record<string, unknown>[]> {
    this.note('GET /api/back-sync/missed-shipments');
    return [];
  }
  async getStuckStaging(): Promise<Record<string, unknown>[]> {
    this.note('GET /api/nav/stuck-staging');
    return [];
  }
  async getPendingFulfillment(): Promise<Record<string, unknown>[]> {
    this.note('GET /api/fulfillment/pending');
    return [];
  }
  async getInventorySyncStatus(): Promise<InventorySyncStatus> {
    this.note('GET /api/inventory-sync/status');
    return { dryRunWouldPush: null, dryRunAt: null, totalPairs: null };
  }
  async getAllocatorStatus(): Promise<AllocatorStatus> {
    this.note('GET /api/allocator/status');
    return {
      lastDecisionAt: null,
      serviceHeartbeatAt: null,
      windowSeconds: null,
      decisionsWindow: null,
      splitCount: null,
      unallocatableCount: null,
      failedCount: null,
      atpFallbackCount: null,
      oosHeldCount: null,
      oosHeldOldestAgeS: null,
      recentDecisions: [],
    };
  }
  // --- Unit 3 stubs: typed empty reads, no live calls (DevOps-gated) ---
  async getJobQueueHealthStatus(): Promise<JobQueueHealthStatus> {
    // Real read-only shape: GET /api/nav/job-queue/health returns the middleware's
    // own {verdict, autoReleaseFiredAt, longestRunningJobS, stuckJobCount,
    // checkedAt}. We ADOPT verdict unchanged (design.md 6), never recompute it.
    this.note('GET /api/nav/job-queue/health');
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
    // the price-sync run/loop timestamp (last-run). SELECT-only / GET-only.
    this.note('GET /api/price-sync/status');
    return { lastReceivedAt: null, lastRunAt: null };
  }
  async getShopifyWebhookStatus(): Promise<ShopifyWebhookStatus> {
    // Real read-only shape: last shopify_webhook_event per topic joined to the
    // live webhook subscription list (subscribed=false => removed subscription).
    this.note('GET /api/webhooks/shopify/health');
    return { topics: [] };
  }
  async getBackSyncStatus(): Promise<BackSyncStatus> {
    this.note('GET /api/back-sync/status');
    return {
      lastBackSyncAt: null,
      watcherHeartbeatAt: null,
      fulfillmentsLast24h: null,
      errorsLast24h: null,
    };
  }
  async getMissedShipmentDetail(): Promise<MissedShipment[] | null> {
    this.note('GET /api/back-sync/missed-shipments');
    // null (not empty) so the missed-shipments signal reads 'unknown' until the
    // endpoint is live; an empty array would falsely read as green (zero missed).
    return null;
  }
}

// Factory. When DevOps provisions MIDDLEWARE_BASE_URL + MIDDLEWARE_AUTH_TOKEN a
// real fetch-based implementation (read-only, Authorization: Bearer) drops in
// here behind the same interface. Until then the stub is returned.
export function createMiddlewareClient(): MiddlewareClient {
  const configured = config.middleware.baseUrl.length > 0;
  if (!configured) {
    return new MiddlewareClientStub();
  }
  // Phase W: replace with a real read-only HTTP client behind MiddlewareClient.
  // Returning the stub keeps the scaffold honest: no live calls until wired.
  return new MiddlewareClientStub();
}
