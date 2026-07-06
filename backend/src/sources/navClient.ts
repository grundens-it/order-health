// Read-only NAV 18 client.
//
// BOUNDARY: NAV access is read-only (design.md section 7). This client only
// SELECTs (IABC watermark, watcher heartbeat state, allocation and shipment
// detail the middleware endpoints do not expose). It opens no write path into
// NAV; the staging-write path stays entirely with the existing middleware.
//
// STUB STATUS: typed interface is the real contract; the implementation returns
// placeholder data because the read-only NAV connection is DevOps-gated.
import { config } from '../config';

export interface NavWatermarkState {
  navNewestIabcEntryNo: number | null;
  watermarkEntryNo: number | null;
  lastWalkAt: string | null;
  watcherHeartbeatAt: string | null;
}

export interface NavClient {
  // IABC watermark + watcher heartbeat for the inventory-sync three-verdict
  // contract (design.md 5A.2). Unit 1 turns this into a real verdict.
  getInventoryWatermarkState(): Promise<NavWatermarkState>;
  // Read-only SQL passthrough for curated templates (design.md section 2).
  queryReadOnly<T>(templateName: string, params?: Record<string, unknown>): Promise<T[]>;
}

class NavClientStub implements NavClient {
  private note(what: string): void {
    // eslint-disable-next-line no-console
    console.info(`[nav:stub] ${what} not queried (DevOps provisioning gated)`);
  }
  async getInventoryWatermarkState(): Promise<NavWatermarkState> {
    this.note('inventory watermark state');
    return {
      navNewestIabcEntryNo: null,
      watermarkEntryNo: null,
      lastWalkAt: null,
      watcherHeartbeatAt: null,
    };
  }
  async queryReadOnly<T>(templateName: string): Promise<T[]> {
    this.note(`read-only template ${templateName}`);
    return [];
  }
}

export function createNavClient(): NavClient {
  const configured = config.nav.host.length > 0;
  if (!configured) {
    return new NavClientStub();
  }
  // Phase W: a real read-only tiberius/mssql client drops in behind NavClient.
  return new NavClientStub();
}
