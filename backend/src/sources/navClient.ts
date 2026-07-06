// Read-only NAV 18 client.
//
// BOUNDARY: NAV access is read-only (design.md section 7). This client only
// SELECTs (IABC watermark, watcher heartbeat state, allocation and shipment
// detail the middleware endpoints do not expose). It opens no write path into
// NAV; the staging-write path stays entirely with the existing middleware.
//
// STUB STATUS: typed interface is the real contract; the implementation returns
// placeholder data because the read-only NAV connection is DevOps-gated.
import type { Channel, InventoryWalk } from '@order-health/shared';
import { config } from '../config';

export interface NavWatermarkState {
  navNewestIabcEntryNo: number | null;
  watermarkEntryNo: number | null;
  lastWalkAt: string | null;
  watcherHeartbeatAt: string | null;
}

// One order's lifecycle timestamps as read from NAV (the Shopify-to-NAV join,
// design.md 4). DTC correlates on [WebId] on GRUS$Sales Header; wholesale is
// keyed on the NAV order number + customer and has an empty WebId with no
// Shopify leg. The order-layer compute (orderLifecycle.ts) turns this row into a
// per-order verdict. All columns are SELECT-only.
export interface NavOrderLifecycleRow {
  // Channel is derived by the query. NOTE: the wholesale-vs-orphan derivation
  // (customer type / order source / series code) is BA open question 1; until it
  // resolves the orphan grading stays behind ORDER_ORPHAN_GRADING_ENABLED.
  channel: Channel;
  navOrderNo: string | null;
  webId: string | null;            // [WebId] on GRUS$Sales Header; empty => DTC orphan candidate OR wholesale
  shopifyOrderName: string | null; // human label, for example "#1024" (DTC)
  customerRef: string | null;      // Sell-to Customer No_ + name (wholesale keying)
  // Per-stage handoff timestamps (null until the handoff happens).
  shopifyOrderAt: string | null;   // DTC: Shopify order received
  allocatorSplitAt: string | null; // DTC: warehouse-splitter allocation decision
  navStagingAt: string | null;     // staged into Sales Header Staging
  navStagingStatus: number | null; // Sales Header Staging [Status]; nonzero + unpromoted => stuck (RED)
  navPromotionAt: string | null;   // promoted to a live NAV order
  navShipmentAt: string | null;    // GRUS$Sales Shipment Header exists (3PL shipped)
  backSyncAt: string | null;       // DTC only: shopify_fulfillment_id present in nav_shipment_sync
  missedBackSync: boolean;         // DTC only: NAV shipment exists, no fulfillment id => RED (design.md 5)
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
  // Per-order lifecycle rows for the order layer (design.md 3.1 / 4). Read-only.
  //
  // Real read-only shape (the Shopify-to-NAV join, all SELECT):
  //   SELECT h.[No_] AS navOrderNo, h.[WebId] AS webId, h.[External Document No_],
  //          h.[Sell-to Customer No_] AS customerRef, h.[Order Date],
  //          st.[Status] AS navStagingStatus, sh.[Posting Date] AS navShipmentAt
  //     FROM [GRUS$Sales Header] h
  //     LEFT JOIN [GRUS$Sales Header Staging] st ON st.[No_] = h.[No_]
  //     LEFT JOIN [GRUS$Sales Shipment Header] sh ON sh.[Order No_] = h.[No_]
  //   -- channel derived from WebId presence + customer type (BA open question 1).
  // The back-sync leg (backSyncAt / missedBackSync) is joined from the middleware
  // nav_shipment_sync view. No write path into NAV (design.md 7).
  getOrderLifecycleRows(): Promise<NavOrderLifecycleRow[]>;
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
  async getOrderLifecycleRows(): Promise<NavOrderLifecycleRow[]> {
    this.note('order lifecycle rows (sales header join)');
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
