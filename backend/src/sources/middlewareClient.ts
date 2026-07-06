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
import { config } from '../config';

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
