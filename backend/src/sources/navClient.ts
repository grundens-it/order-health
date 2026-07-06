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

// Unit 3b (inventory dry-run reconstruction). Current NAV available-to-promise
// for one (sku, NAV location code) pair. This is the SAME number the middleware's
// inventory-sync cron pushes to Shopify (the corrected available-to-promise,
// clamped to the raw ledger — see the middleware's query_nav_qty). Reading it
// read-only lets us rebuild the middleware's dry-run "would push" predicate
// ourselves (design.md 5A.2 / 5A.3) instead of leaving it null. SELECT-only.
export interface NavInventoryAvailabilityRow {
  sku: string | null;         // [Item No_]
  location: string | null;    // [Location Code] (e.g. HF1FTZ / TAC)
  availableQty: number | null; // corrected available-to-promise at that location
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
  // Unit 3b (inventory dry-run reconstruction). Current NAV available-to-promise
  // per (sku, location) so we can rebuild the middleware's inventory dry-run
  // "would push" count read-only (a pair whose NAV availability now differs from
  // the quantity last pushed to Shopify would be pushed by a real dry-run).
  //
  // Real read-only shape (mirrors the inventory-sync cron's per-pair NAV read;
  // corrected available-to-promise, clamped to the raw ledger total — SELECT only):
  //   SELECT ile.[Item No_] AS sku, ile.[Location Code] AS location,
  //          SUM(ile.[Remaining Quantity]) AS availableQty
  //     FROM [GRUS$Item Ledger Entry] ile
  //    WHERE ile.[Open] = 1
  //    GROUP BY ile.[Item No_], ile.[Location Code]
  // No write path into NAV (design.md 7).
  getInventoryAvailability(): Promise<NavInventoryAvailabilityRow[]>;
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
  async getRecentShipments(limit: number): Promise<NavShipmentHeader[]> {
    this.note(`recent NAV shipments (limit ${limit})`);
    return [];
  }
  async getInventoryAvailability(): Promise<NavInventoryAvailabilityRow[]> {
    this.note('NAV inventory availability (item ledger by sku + location)');
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
