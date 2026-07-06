// Read-only NAV 18 client.
//
// BOUNDARY: NAV access is read-only (design.md section 7). This client only
// SELECTs (IABC watermark, watcher heartbeat state, allocation and shipment
// detail the middleware endpoints do not expose). It opens no write path into
// NAV; the staging-write path stays entirely with the existing middleware.
//
// STUB STATUS: typed interface is the real contract; the implementation returns
// placeholder data because the read-only NAV connection is DevOps-gated.
import type { InventoryWalk } from '@order-health/shared';
import { config } from '../config';

export interface NavWatermarkState {
  navNewestIabcEntryNo: number | null;
  watermarkEntryNo: number | null;
  lastWalkAt: string | null;
  watcherHeartbeatAt: string | null;
}

// Unit 2 (back-sync). A row from GRUS$Sales Shipment Header: a posted NAV shipment
// used to enrich the missed-shipments detail (carrier / tracking / posted time)
// the middleware endpoint does not fully expose. Read-only (SELECT only).
export interface NavShipmentHeader {
  navShipmentNo: string | null;   // [No_]
  webId: string | null;           // [WebId] (null => wholesale, no Shopify leg)
  orderRef: string | null;        // originating order (Shopify name or NAV order no)
  carrier: string | null;         // [Shipping Agent Code]
  tracking: string | null;        // [Package Tracking No_]
  postedAt: string | null;        // [Posting Date] / posting time
}

export interface NavClient {
  // IABC watermark + watcher heartbeat for the inventory-sync three-verdict
  // contract (design.md 5A.2). Unit 1 turns this into a real verdict.
  //
  // Real read-only shape (from the demo SQL console, design.md section 2):
  //   SELECT MAX([Entry No_]) FROM [Job Queue Log Entry]
  //     WHERE [Object ID to Run] = 50007 AND [Status] = 2   -- newest IABC completion
  // plus the middleware's inventory_sync.last_iabc_job_entry_no watermark and the
  // watcher heartbeat row. All SELECT-only: no write path into NAV (design.md 7).
  getInventoryWatermarkState(): Promise<NavWatermarkState>;
  // Recent catalog walks (processed / pushed / skipped / untracked) from the NAV
  // Job Queue Log, most-recent-first. Feeds the push-outcome verdict, the recent-
  // walks bar chart, and the walks table. Read-only.
  getRecentInventoryWalks(limit: number): Promise<InventoryWalk[]>;
  // Unit 2 (back-sync). Recently posted NAV shipments from GRUS$Sales Shipment
  // Header, most-recent-first, to enrich missed-shipments detail. Read-only.
  //
  // Real read-only shape (design.md section 4, the existing missed-shipments query):
  //   SELECT sh.[No_], sh.[WebId], sh.[Shipping Agent Code],
  //          sh.[Package Tracking No_], sh.[Posting Date]
  //     FROM [GRUS$Sales Shipment Header] sh
  //     LEFT JOIN nav_shipment_sync s ON s.nav_shipment = sh.[No_]
  //    WHERE s.shopify_fulfillment_id IS NULL AND sh.[WebId] <> ''  -- DTC only
  // SELECT-only: no write path into NAV (design.md 7).
  getRecentShipments(limit: number): Promise<NavShipmentHeader[]>;
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
  async getRecentInventoryWalks(limit: number): Promise<InventoryWalk[]> {
    this.note(`recent inventory walks (limit ${limit})`);
    return [];
  }
  async getRecentShipments(limit: number): Promise<NavShipmentHeader[]> {
    this.note(`recent NAV shipments (limit ${limit})`);
    return [];
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
