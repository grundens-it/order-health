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
