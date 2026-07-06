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
      recentDecisions: [],
    };
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
