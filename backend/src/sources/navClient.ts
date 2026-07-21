// Read-only NAV 18 client (Azure SQL, Microsoft Entra auth).
//
// BOUNDARY: NAV access is strictly read-only (design.md section 7). This client
// only issues SELECT statements (IABC watermark, watcher heartbeat / liveness,
// order lifecycle join, posted shipment detail). It opens NO write path into
// NAV; the staging-write path stays entirely with the existing middleware. The
// Entra identity this connects as is granted db_datareader ONLY (see
// docs/DATA_SOURCES.md), so writes are impossible by grant AND blocked in code
// (assertReadOnly) as defence in depth.
//
// AUTH: the NAV box (sql-grus-prd-01) has NO SQL username/password. Auth is
// Microsoft Entra (Azure AD), selected by NAV_AUTH_MODE:
//   aad-default          -> azure-active-directory-default (local dev via az login)
//   aad-service-principal -> azure-active-directory-service-principal-secret
//   aad-msi              -> azure-active-directory-msi-app-service (managed identity)
//
// COMPANY: the NAV DB is multi-company. EVERY table MUST be prefixed with the
// company code ('GRUS' for Grundens US) or you read another company's data. The
// prefix is built from NAV_COMPANY, never hardcoded per query.
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
  // Channel is derived by the query from [WebOrder]: WebOrder = 1 => dtc,
  // WebOrder = 0 => wholesale (DATA_SOURCES.md, the orphan-vs-wholesale answer).
  channel: Channel;
  navOrderNo: string | null;
  webId: string | null;            // [WebId] on GRUS$Sales Header; empty => DTC orphan candidate OR wholesale
  // [WebOrder] (tinyint) on GRUS$Sales Header. 1 => a web/DTC order, 0 => not a
  // web order (wholesale / manual). This is the field that gates orphan grading:
  // an empty WebId is an orphan ONLY when WebOrder = 1 (design.md 9 / DATA_SOURCES).
  webOrder: number | null;
  shopifyOrderName: string | null; // human label, for example "#1024" (DTC)
  customerRef: string | null;      // Sell-to Customer No_ + name (wholesale keying)
  // Per-stage handoff timestamps (null until the handoff happens).
  shopifyOrderAt: string | null;   // DTC: Shopify order received ([Order Date] on the NAV header)
  allocatorSplitAt: string | null; // DTC: warehouse-splitter allocation decision (middleware-sourced)
  navStagingAt: string | null;     // staged into Sales Header Staging (middleware-sourced)
  navStagingStatus: number | null; // Sales Header Staging [Status]; nonzero + unpromoted => stuck (RED)
  navPromotionAt: string | null;   // promoted to a live NAV order (middleware-sourced)
  navShipmentAt: string | null;    // GRUS$Sales Shipment Header [Posting Date] (3PL shipped)
  backSyncAt: string | null;       // DTC only: shopify_fulfillment_id present in nav_shipment_sync (middleware)
  missedBackSync: boolean;         // DTC only: NAV shipment exists, no fulfillment id => RED (design.md 5)
  // Round 3 (Unit 2). GRUS$Sales Header [Document Type]: 1 = Order (outbound sale),
  // 5 = Return Order. Happy Returns are Document Type 5 (No_ like "HR-...", empty
  // customer); they are NOT outbound stalls and must never be graded awaiting_ship.
  documentType: number | null;
}

// Round 3 (Unit 1). One outstanding sales-order line, used to map an awaiting_ship
// order to its item SKU(s) so the FS-location available can be reconciled against
// NAV warehouse on-hand. GRUS$Sales Line: [Document Type] = 1 (Order), [Type] = 2
// (Item), [Outstanding Quantity] <> 0. SELECT-only.
export interface NavOrderLine {
  orderNo: string | null;      // [Document No_]
  sku: string | null;          // [No_] (item)
  location: string | null;     // [Location Code]
  outstandingQty: number | null; // [Outstanding Quantity]
}

// One IABC row for a SKU at a location/channel: on-hand and available-to-ship (ATP)
// from GRUS$ItemAvailabilityByChannel. Lets the modal show inventory across HF1FTZ
// AND TAC with both on-hand and available-to-ship.
export interface NavIabcRow {
  sku: string | null;
  location: string | null;
  channel: string | null;
  onHand: number | null;    // [Qty On Hand]
  available: number | null; // [Qty Available] (available to ship)
  earliestShipDate: string | null; // [Earliest Shipment Date] (1753 => never)
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
  orderRef: string | null;        // originating order ([Order No_])
  carrier: string | null;         // [Shipping Agent Code]
  tracking: string | null;        // [Package Tracking No_]
  postedAt: string | null;        // [Posting Date] / posting time
}

// Unit 1 (nav_job_queue, ADR-0007). The job-queue verdict is COMPUTED from
// read-only NAV, not adopted from the middleware. Three independent NAV reads:
//   - the last CU 50009 auto-release firing (liveness),
//   - the oldest IN-PROCESS CU 50007 run (a genuinely stuck IABC job),
//   - the count of real Status = 0 pending-promotion staging rows.
// All SELECT-only, GRUS$-prefixed. The middleware's own level / stuck-staging
// number is read separately and kept only as a labelled cross-check.
export interface NavJobQueueState {
  autoReleaseFiredAt: string | null;   // newest completed CU 50009 (auto-release) firing
  oldestInProcessJobAt: string | null; // start time of the oldest in-process CU 50007 run
  inProcessJobCount: number | null;    // CU 50007 rows currently In Process (null = unread)
  pendingStagingCount: number | null;  // GRUS$Sales Header Staging rows with Status = 0 (null = unread)
}

export interface NavClient {
  getInventoryWatermarkState(): Promise<NavWatermarkState>;
  getRecentInventoryWalks(limit: number): Promise<InventoryWalk[]>;
  getOrderLifecycleRows(): Promise<NavOrderLifecycleRow[]>;
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
  // Unit 1 (nav_job_queue). Read-only NAV job-queue state (auto-release firing,
  // in-process CU 50007, real Status=0 staging backlog) so the verdict is computed,
  // not adopted from the middleware. See jobQueue.ts.
  getJobQueueState(): Promise<NavJobQueueState>;
  // Unit 2 (back_sync has-work gate). The posting time of the newest DTC (WebId
  // present) NAV shipment. Compared against the back-sync watermark to decide
  // whether any UNSYNCED work exists: if the newest DTC shipment is not newer than
  // the last back-sync, the watcher is idle-not-behind and the clocks must not age.
  getNewestDtcShipmentAt(): Promise<string | null>;
  // Round 3 (Unit 1). Outstanding item lines for open sales orders (Document Type 1,
  // Type 2, Outstanding Quantity <> 0), bounded, so an awaiting_ship order can be
  // mapped to its SKU(s) for the FS-vs-warehouse reconciliation.
  getOutstandingOrderLines(limit: number): Promise<NavOrderLine[]>;
  // Per-line: SKUs already shipped for orders (GRUS$Sales Shipment Line), so a
  // partially-shipped order is recognized as in-NAV across all of its lines.
  getShippedOrderLines(limit: number): Promise<NavOrderLine[]>;
  // Per-SKU IABC on-hand + available-to-ship across HF1FTZ + TAC (for the modal).
  getIabcBySku(sku: string): Promise<NavIabcRow[]>;
  // Read-only SQL passthrough for curated templates (design.md section 2).
  queryReadOnly<T>(templateName: string, params?: Record<string, unknown>): Promise<T[]>;
}

// ---------------------------------------------------------------------------
// PURE HELPERS (no I/O). These are the unit-tested surface: the query builders
// assert every table is GRUS$-prefixed and the CU 50007 watermark SQL is right,
// and the mappers turn fake recordset rows into the typed shapes above. None of
// them touch a live connection, so they run without NAV / az login.
// ---------------------------------------------------------------------------

// Newest completed IABC (Inventory Availability by Channel) job runs as NAV
// Codeunit 50007. NAV Job Queue Log Entry [Status] is an option: 0 = Success,
// 1 = In Process, 2 = Error. Confirmed live: Status 0 has 8,866 rows with the
// newest completing minutes ago, Status 2 has 12 rows last seen in 2022. So a
// completed run is Status = 0 (DATA_SOURCES.md originally said 2, which is Error).
export const NAV_IABC_OBJECT_ID = 50007;
export const NAV_JOB_STATUS_SUCCESS = 0;
// NAV Job Queue Log Entry [Status] option: 0 = Success, 1 = In Process, 2 = Error.
// CU 50009 is the auto-release codeunit (the job-queue liveness heartbeat); a
// genuinely stuck IABC job is a CU 50007 run still In Process past a real threshold.
export const NAV_JOB_STATUS_IN_PROCESS = 1;
export const NAV_AUTO_RELEASE_OBJECT_ID = 50009;
// Unit C (health-fidelity integration). The CURRENT in-process truth is
// GRUS$Job Queue Entry, whose [Status] = 1 is "In Process". The stuck-job signal
// MUST read this live table, NOT the GRUS$Job Queue Log Entry audit trail: 108 log
// rows are stale In-Process back to 2021 (crashed jobs whose log row never closed),
// and the oldest of those false-flagged a 1,173-day stuck job (a false RED). A job
// that is genuinely running still appears here; a crashed one does not.
export const NAV_JQE_STATUS_IN_PROCESS = 1;
// GRUS$Sales Header Staging [Status] = 0 is a real row pending promotion (the true
// backlog). Status = 1 rows are old "Not Auto-released" rows and are NOT counted.
export const NAV_STAGING_STATUS_PENDING_PROMOTION = 0;

// Bracketed, company-prefixed table name: navTable('GRUS', 'Sales Header') =>
// "[GRUS$Sales Header]". Centralising this is what guarantees no query can read
// another company's data.
export function navTable(company: string, table: string): string {
  return `[${company}$${table}]`;
}

// The SELECT-only statements, all company-prefixed via navTable. Returned as a
// map so tests can assert the prefixing and the watermark predicate directly.
export interface NavQueries {
  iabcWatermark: string;    // newest completed CU 50007 entry (no_ + end time)
  watcherHeartbeat: string; // newest CU 50007 entry of any status (liveness)
  recentWalks: string;      // recent completed CU 50007 entries for the walks table
  orderLifecycle: string;   // Sales Header join (header + staging + shipment)
  recentShipments: string;  // posted GRUS$Sales Shipment Header rows
  inventoryAvailability: string; // ATP per (sku, location) for the dry-run rebuild
  autoReleaseFiring: string; // Unit 1: newest completed CU 50009 auto-release firing
  inProcessJobs: string;     // Unit 1: in-process CU 50007 runs, oldest first (stuck-job)
  pendingStagingCount: string; // Unit 1: count of Status = 0 pending-promotion staging rows
  newestDtcShipment: string; // Unit 2: posting time of the newest DTC (WebId) shipment
  outstandingOrderLines: string; // Round 3: outstanding item lines for open sales orders
  shippedOrderLines: string;     // Per-line: SKUs already shipped (GRUS$Sales Shipment Line)
  iabcAvailability: string;      // Per-SKU on-hand + available-to-ship across HF1FTZ + TAC
}

export function buildQueries(company: string): NavQueries {
  const jqLog = navTable(company, 'Job Queue Log Entry');
  const jqEntry = navTable(company, 'Job Queue Entry');
  const salesHeader = navTable(company, 'Sales Header');
  const salesLine = navTable(company, 'Sales Line');
  const staging = navTable(company, 'Sales Header Staging');
  const shipment = navTable(company, 'Sales Shipment Header');
  const shipmentLine = navTable(company, 'Sales Shipment Line');
  const iabc = navTable(company, 'ItemAvailabilityByChannel');
  const itemLedger = navTable(company, 'Item Ledger Entry');

  return {
    // IABC watermark: newest CU 50007 completion (design.md / DATA_SOURCES.md).
    iabcWatermark: `SELECT TOP 1 [Entry No_] AS entryNo, [Start Date_Time] AS startAt, [End Date_Time] AS endAt
FROM ${jqLog}
WHERE [Object ID to Run] = @iabcObjectId AND [Status] = @successStatus
ORDER BY [Entry No_] DESC;`,
    // Liveness: newest CU 50007 log row of ANY status => the watcher is running.
    watcherHeartbeat: `SELECT TOP 1 [Entry No_] AS entryNo, [Start Date_Time] AS startAt, [End Date_Time] AS endAt, [Status] AS status
FROM ${jqLog}
WHERE [Object ID to Run] = @iabcObjectId
ORDER BY [Entry No_] DESC;`,
    // Recent completed walks for the walks table / bar chart.
    recentWalks: `SELECT TOP (@limit) [Entry No_] AS entryNo, [Start Date_Time] AS startAt, [End Date_Time] AS endAt, [Status] AS status
FROM ${jqLog}
WHERE [Object ID to Run] = @iabcObjectId AND [Status] = @successStatus
ORDER BY [Entry No_] DESC;`,
    // Order lifecycle: header + staging status + latest posted shipment. WebOrder
    // is selected so the channel and the orphan predicate can use it. Bounded to
    // the most recent orders (Sales Header holds only open/active orders; NAV
    // deletes fully posted ones), and the shipment posting date is a scalar
    // subquery (MAX) rather than a join, so an order with multiple shipments
    // stays ONE row instead of fanning out into duplicates.
    orderLifecycle: `SELECT TOP (@limit) h.[No_] AS navOrderNo, h.[Sell-to Customer No_] AS customerRef,
       h.[Order Date] AS orderDate, h.[WebId] AS webId, h.[WebOrder] AS webOrder,
       h.[Document Type] AS documentType,
       st.[Status] AS navStagingStatus,
       (SELECT MAX(sh.[Posting Date]) FROM ${shipment} sh WHERE sh.[Order No_] = h.[No_]) AS navShipmentAt
FROM ${salesHeader} h
LEFT JOIN ${staging} st ON st.[Nav Order No] = h.[No_]
ORDER BY h.[Order Date] DESC;`,
    // Posted shipments, most-recent-first.
    recentShipments: `SELECT TOP (@limit) sh.[No_] AS navShipmentNo, sh.[WebId] AS webId,
       sh.[Order No_] AS orderRef, sh.[Shipping Agent Code] AS carrier,
       sh.[Package Tracking No_] AS tracking, sh.[Posting Date] AS postedAt
FROM ${shipment} sh
ORDER BY sh.[Posting Date] DESC;`,
    // Current available-to-promise per (sku, location) from open item ledger
    // entries. Mirrors the inventory-sync cron's per-pair NAV read so we can
    // rebuild the dry-run "would push" count. SELECT-only, GRUS$-prefixed.
    inventoryAvailability: `SELECT ile.[Item No_] AS sku, ile.[Location Code] AS location,
       SUM(ile.[Remaining Quantity]) AS availableQty
FROM ${itemLedger} ile
WHERE ile.[Open] = 1
GROUP BY ile.[Item No_], ile.[Location Code];`,
    // Unit 1 liveness: newest completed CU 50009 auto-release firing.
    autoReleaseFiring: `SELECT TOP 1 [Entry No_] AS entryNo, [Start Date_Time] AS startAt, [End Date_Time] AS endAt
FROM ${jqLog}
WHERE [Object ID to Run] = @autoReleaseObjectId AND [Status] = @successStatus
ORDER BY [Entry No_] DESC;`,
    // Unit C stuck-job: CURRENTLY in-process jobs from GRUS$Job Queue Entry (the
    // live state), scoped to the IABC / auto-release codeunits, oldest first. This
    // replaces the Unit 1 read of GRUS$Job Queue Log Entry, whose stale In-Process
    // rows (crashed jobs back to 2021) false-flagged a 1,173-day stuck job. Each
    // in-process entry's actual start comes from its OWN current in-process log row
    // (matched on [ID]); an entry with no such log row has a null start (unknown
    // age), never a fabricated one. The oldest real start ages the stuck-job band.
    inProcessJobs: `SELECT jqe.[ID] AS id, jqe.[Object ID to Run] AS objectId,
       (SELECT MAX(l.[Start Date_Time]) FROM ${jqLog} l
          WHERE l.[ID] = jqe.[ID] AND l.[Status] = @logInProcessStatus) AS startAt
FROM ${jqEntry} jqe
WHERE jqe.[Status] = @jqeInProcessStatus
  AND jqe.[Object ID to Run] IN (@iabcObjectId, @autoReleaseObjectId)
ORDER BY startAt ASC;`,
    // Unit 1 staging backlog: count of REAL pending-promotion rows (Status = 0),
    // NOT the old Status = 1 "Not Auto-released" rows the middleware endpoint counts.
    pendingStagingCount: `SELECT COUNT(*) AS pendingCount
FROM ${staging}
WHERE [Status] = @pendingStatus;`,
    // Unit 2 has-work gate: posting time of the newest DTC (WebId present) shipment.
    // Wholesale shipments have no Shopify back-sync leg, so they are excluded.
    newestDtcShipment: `SELECT TOP 1 sh.[Posting Date] AS postedAt
FROM ${shipment} sh
WHERE sh.[WebId] IS NOT NULL AND sh.[WebId] <> ''
ORDER BY sh.[Posting Date] DESC;`,
    // Round 3 (Unit 1): outstanding ITEM lines (Type = 2) for open sales orders
    // (Document Type = 1) with unshipped quantity, most-recent-first. Maps an
    // awaiting_ship order to its SKU(s) for the FS-vs-warehouse reconciliation.
    outstandingOrderLines: `SELECT TOP (@limit) sl.[Document No_] AS orderNo, sl.[No_] AS sku,
       sl.[Location Code] AS location, sl.[Outstanding Quantity] AS outstandingQty
FROM ${salesLine} sl
WHERE sl.[Document Type] = 1 AND sl.[Type] = 2 AND sl.[Outstanding Quantity] <> 0
ORDER BY sl.[Document No_] DESC;`,
    // Per-line NAV presence across ALL lines: SKUs already shipped for an order,
    // from posted GRUS$Sales Shipment Line ([Order No_] is the NAV leg, [No_] the
    // item). Lets a partially-shipped order be recognized as in-NAV and its shipped
    // lines excluded from the "dropped line" test.
    shippedOrderLines: `SELECT TOP (@limit) sl.[Order No_] AS orderNo, sl.[No_] AS sku,
       sl.[Location Code] AS location, sl.[Quantity] AS outstandingQty
FROM ${shipmentLine} sl
WHERE sl.[Type] = 2 AND sl.[Quantity] <> 0
ORDER BY sl.[Posting Date] DESC;`,
    // Per-SKU IABC across the two physical warehouses HF1FTZ (Holman) + TAC:
    // on-hand ([Qty On Hand]) and available-to-ship ([Qty Available]) per channel.
    // Lets the modal show where TAC has inventory, not just HF1FTZ, with both numbers.
    iabcAvailability: `SELECT [No_] AS sku, [Location] AS location, [Channel] AS channel,
       [Qty On Hand] AS onHand, [Qty Available] AS available,
       [Earliest Shipment Date] AS earliestShipDate
FROM ${iabc}
WHERE [No_] = @sku AND [Location] IN ('HF1FTZ', 'TAC')
ORDER BY [Location], [Channel];`,
  };
}

// Normalise a NAV datetime/date value (mssql returns Date objects; may also be a
// string or null) to an ISO string or null.
// NAV uses 1753-01-01 (SQL Server datetime minimum) as a blank / never sentinel.
// Treat any such value as null so downstream age math does not produce a
// ~273-year lag that overflows the snapshot's integer columns.
function isNavSentinelDate(d: Date): boolean {
  return d.getUTCFullYear() <= 1753;
}

export function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime()) || isNavSentinelDate(v)) return null;
    return v.toISOString();
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isNaN(t)) return null;
    const d = new Date(t);
    return isNavSentinelDate(d) ? null : d.toISOString();
  }
  return null;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

// A single recordset row is a loose bag of column -> value.
export type Row = Record<string, unknown>;

// Map the IABC watermark + heartbeat recordset rows to NavWatermarkState. The
// watermarkEntryNo (what the middleware last PROCESSED) is NOT in NAV; it lives
// in the middleware's inventory_sync state, so it is null here and supplied by
// the middleware client in the follow-on unit.
export function mapWatermarkState(
  watermark: Row | undefined,
  heartbeat: Row | undefined,
): NavWatermarkState {
  return {
    navNewestIabcEntryNo: watermark ? toNum(watermark.entryNo) : null,
    watermarkEntryNo: null,
    lastWalkAt: watermark ? (toIso(watermark.endAt) ?? toIso(watermark.startAt)) : null,
    watcherHeartbeatAt: heartbeat ? (toIso(heartbeat.startAt) ?? toIso(heartbeat.endAt)) : null,
  };
}

// Map a Job Queue Log row to an InventoryWalk. The per-walk push/skip counts are
// middleware-side (NAV's Job Queue Log records completion, not the walk deltas),
// so they are 0 here; the middleware inventory-sync endpoint enriches them.
export function mapInventoryWalk(row: Row): InventoryWalk {
  return {
    walk_at: toIso(row.endAt) ?? toIso(row.startAt),
    processed: 0,
    pushed: 0,
    skipped: 0,
    untracked_filtered: 0,
  };
}

// Map an item-ledger availability row to the typed ATP shape (Unit 3b dry-run).
export function mapInventoryAvailabilityRow(row: Row): NavInventoryAvailabilityRow {
  return {
    sku: toStr(row.sku),
    location: toStr(row.location),
    availableQty: toNum(row.availableQty),
  };
}

// Derive the channel from WebOrder: 1 => dtc (web), otherwise wholesale.
export function channelFromWebOrder(webOrder: number | null): Channel {
  return webOrder === 1 ? 'dtc' : 'wholesale';
}

// Map a Sales Header join row to a NavOrderLifecycleRow. Middleware-sourced hop
// timestamps (allocator split, staging/promotion time, back-sync) stay null here;
// this client only surfaces what NAV itself holds. missedBackSync is a
// middleware-join signal, false from NAV alone.
export function mapOrderLifecycleRow(row: Row): NavOrderLifecycleRow {
  const webOrder = toNum(row.webOrder);
  const channel = channelFromWebOrder(webOrder);
  const orderAt = toIso(row.orderDate);
  return {
    channel,
    navOrderNo: toStr(row.navOrderNo),
    webId: typeof row.webId === 'string' ? row.webId : toStr(row.webId),
    webOrder,
    shopifyOrderName: null,
    customerRef: toStr(row.customerRef),
    shopifyOrderAt: channel === 'dtc' ? orderAt : null,
    allocatorSplitAt: null,
    navStagingAt: null,
    navStagingStatus: toNum(row.navStagingStatus),
    navPromotionAt: null,
    navShipmentAt: toIso(row.navShipmentAt),
    backSyncAt: null,
    missedBackSync: false,
    documentType: toNum(row.documentType),
  };
}

// Round 3 (Unit 1). Map a GRUS$Sales Line row to a NavOrderLine.
export function mapOrderLine(row: Row): NavOrderLine {
  return {
    orderNo: toStr(row.orderNo),
    sku: toStr(row.sku),
    location: toStr(row.location),
    outstandingQty: toNum(row.outstandingQty),
  };
}

export function mapIabcRow(row: Row): NavIabcRow {
  return {
    sku: toStr(row.sku),
    location: toStr(row.location),
    channel: toStr(row.channel),
    onHand: toNum(row.onHand),
    available: toNum(row.available),
    earliestShipDate: toIso(row.earliestShipDate),
  };
}

export function mapShipmentHeader(row: Row): NavShipmentHeader {
  return {
    navShipmentNo: toStr(row.navShipmentNo),
    webId: toStr(row.webId),
    orderRef: toStr(row.orderRef),
    carrier: toStr(row.carrier),
    tracking: toStr(row.tracking),
    postedAt: toIso(row.postedAt),
  };
}

// Unit 1: assemble NavJobQueueState from the three read-only job-queue reads. An
// empty inProcess recordset is a genuine "no in-process job" (count 0, healthy),
// distinct from an unread source (the stub returns count null => unknown). The
// oldest in-process row is first (queried ORDER BY start ASC) so the compute ages
// the longest-running job. Pure: fake rows in, typed state out (no live call).
export function mapJobQueueState(
  autoRelease: Row | undefined,
  inProcess: Row[],
  staging: Row | undefined,
): NavJobQueueState {
  const oldest = inProcess[0];
  return {
    autoReleaseFiredAt: autoRelease
      ? (toIso(autoRelease.endAt) ?? toIso(autoRelease.startAt))
      : null,
    oldestInProcessJobAt: oldest ? toIso(oldest.startAt) : null,
    inProcessJobCount: inProcess.length,
    pendingStagingCount: staging ? toNum(staging.pendingCount) : null,
  };
}

// Read-only enforcement. Reject any statement that could mutate NAV. Applied to
// every query the live client runs (defence in depth on top of the db_datareader
// grant). Pure => unit-tested against write statements.
const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|EXEC|EXECUTE|SP_)\b/i;
export function assertReadOnly(sql: string): void {
  if (WRITE_KEYWORDS.test(sql)) {
    throw new Error('nav: refusing to run a non-SELECT (read-only NAV client)');
  }
}

// ---------------------------------------------------------------------------
// AUTH SELECTION (pure). Build the mssql `authentication` block from NAV_AUTH_MODE.
// ---------------------------------------------------------------------------
export type NavAuthMode = 'aad-default' | 'aad-service-principal' | 'aad-msi';

export interface NavAuthentication {
  type:
    | 'azure-active-directory-default'
    | 'azure-active-directory-service-principal-secret'
    | 'azure-active-directory-msi-app-service';
  options?: { clientId: string; clientSecret: string; tenantId: string };
}

export function buildAuthentication(nav: typeof config.nav): NavAuthentication {
  switch (nav.authMode as NavAuthMode) {
    case 'aad-service-principal':
      return {
        type: 'azure-active-directory-service-principal-secret',
        options: {
          clientId: nav.aadClientId,
          clientSecret: nav.aadClientSecret,
          tenantId: nav.aadTenantId,
        },
      };
    case 'aad-msi':
      return { type: 'azure-active-directory-msi-app-service' };
    case 'aad-default':
    default:
      // Local dev: uses the ambient Azure credential chain (az login).
      return { type: 'azure-active-directory-default' };
  }
}

// Build the mssql ConnectionPool config from the nav config. Kept pure/exported
// so the connection shape (server, encrypt, Entra auth) is inspectable in tests.
export function buildPoolConfig(nav: typeof config.nav): Record<string, unknown> {
  return {
    server: nav.host,
    port: nav.port,
    database: nav.database,
    authentication: buildAuthentication(nav),
    options: {
      encrypt: nav.encrypt,
      trustServerCertificate: false,
    },
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
  };
}

// ---------------------------------------------------------------------------
// STUB (kept forever). Returned when NAV is not configured, and the fallback the
// live client degrades to when NAV is unreachable so the app still boots.
// ---------------------------------------------------------------------------
export class NavClientStub implements NavClient {
  private note(what: string): void {
    // eslint-disable-next-line no-console
    console.info(`[nav:stub] ${what} not queried (NAV not configured / unreachable)`);
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
  async getJobQueueState(): Promise<NavJobQueueState> {
    this.note('job-queue state (CU 50009 auto-release + CU 50007 in-process + staging)');
    // All null => the three sub-verdicts read 'unknown' (unread source), never a
    // false green. inProcessJobCount null is "unread", distinct from a real 0.
    return {
      autoReleaseFiredAt: null,
      oldestInProcessJobAt: null,
      inProcessJobCount: null,
      pendingStagingCount: null,
    };
  }
  async getNewestDtcShipmentAt(): Promise<string | null> {
    this.note('newest DTC shipment posting time (back-sync has-work gate)');
    // null => the has-work gate cannot detect unsynced work; the pipe rolls up to
    // unknown via the missed-shipments signal rather than a false idle-green.
    return null;
  }
  async getOutstandingOrderLines(limit: number): Promise<NavOrderLine[]> {
    this.note(`outstanding order lines (limit ${limit})`);
    return [];
  }
  async getShippedOrderLines(limit: number): Promise<NavOrderLine[]> {
    this.note(`shipped order lines (limit ${limit})`);
    return [];
  }
  async getIabcBySku(sku: string): Promise<NavIabcRow[]> {
    this.note(`iabc availability (${sku})`);
    return [];
  }
  async queryReadOnly<T>(templateName: string): Promise<T[]> {
    this.note(`read-only template ${templateName}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// LIVE client. Lazily opens ONE shared mssql pool on first query. Every query is
// a parameterised SELECT run through assertReadOnly. On any connection/query
// failure it logs once and degrades to the stub's empty shapes (verdicts become
// 'unknown'), so an unreachable NAV never crashes the app or blocks boot. No
// connection is made at import time.
// ---------------------------------------------------------------------------
class NavClientLive implements NavClient {
  private readonly queries: NavQueries;
  private readonly stub = new NavClientStub();
  // mssql types are loaded lazily (dynamic import) to keep import-time light and
  // to avoid a hard failure if the optional native pieces are unavailable.
  private poolPromise: Promise<import('mssql').ConnectionPool> | null = null;
  private degraded = false;

  constructor(nav: typeof config.nav) {
    this.queries = buildQueries(nav.company);
  }

  private async getPool(): Promise<import('mssql').ConnectionPool> {
    if (this.poolPromise === null) {
      this.poolPromise = (async () => {
        const mssql = (await import('mssql')).default;
        const pool = new mssql.ConnectionPool(
          buildPoolConfig(config.nav) as unknown as import('mssql').config,
        );
        await pool.connect();
        return pool;
      })();
    }
    return this.poolPromise;
  }

  // Run a parameterised SELECT and return its first recordset. Any failure resets
  // the pool and rethrows to the caller's degrade path.
  private async select(sql: string, params: Record<string, unknown> = {}): Promise<Row[]> {
    assertReadOnly(sql);
    const pool = await this.getPool();
    const request = pool.request();
    for (const [k, v] of Object.entries(params)) {
      request.input(k, v);
    }
    const result = await request.query(sql);
    return (result.recordset ?? []) as Row[];
  }

  // Degrade helper: log the failure once and return the stub's value.
  private degrade<T>(what: string, err: unknown, fallback: T): T {
    if (!this.degraded) {
      this.degraded = true;
      // eslint-disable-next-line no-console
      console.warn(`[nav:live] ${what} failed; degrading to stub (unknown): ${String(err)}`);
    }
    this.poolPromise = null; // allow a later retry to reconnect
    return fallback;
  }

  async getInventoryWatermarkState(): Promise<NavWatermarkState> {
    try {
      const [watermark, heartbeat] = await Promise.all([
        this.select(this.queries.iabcWatermark, {
          iabcObjectId: NAV_IABC_OBJECT_ID,
          successStatus: NAV_JOB_STATUS_SUCCESS,
        }),
        this.select(this.queries.watcherHeartbeat, { iabcObjectId: NAV_IABC_OBJECT_ID }),
      ]);
      return mapWatermarkState(watermark[0], heartbeat[0]);
    } catch (err) {
      return this.degrade('inventory watermark state', err, this.stub.getInventoryWatermarkState());
    }
  }

  async getRecentInventoryWalks(limit: number): Promise<InventoryWalk[]> {
    try {
      const rows = await this.select(this.queries.recentWalks, {
        iabcObjectId: NAV_IABC_OBJECT_ID,
        successStatus: NAV_JOB_STATUS_SUCCESS,
        limit,
      });
      return rows.map(mapInventoryWalk);
    } catch (err) {
      return this.degrade('recent inventory walks', err, this.stub.getRecentInventoryWalks(limit));
    }
  }

  async getOrderLifecycleRows(): Promise<NavOrderLifecycleRow[]> {
    try {
      const rows = await this.select(this.queries.orderLifecycle, {
        limit: config.nav.orderIngestLimit,
      });
      return rows.map(mapOrderLifecycleRow);
    } catch (err) {
      return this.degrade('order lifecycle rows', err, this.stub.getOrderLifecycleRows());
    }
  }

  async getRecentShipments(limit: number): Promise<NavShipmentHeader[]> {
    try {
      const rows = await this.select(this.queries.recentShipments, { limit });
      return rows.map(mapShipmentHeader);
    } catch (err) {
      return this.degrade('recent NAV shipments', err, this.stub.getRecentShipments(limit));
    }
  }

  async getInventoryAvailability(): Promise<NavInventoryAvailabilityRow[]> {
    try {
      const rows = await this.select(this.queries.inventoryAvailability, {});
      return rows.map(mapInventoryAvailabilityRow);
    } catch (err) {
      return this.degrade('inventory availability', err, this.stub.getInventoryAvailability());
    }
  }

  async getJobQueueState(): Promise<NavJobQueueState> {
    try {
      const [autoRelease, inProcess, staging] = await Promise.all([
        this.select(this.queries.autoReleaseFiring, {
          autoReleaseObjectId: NAV_AUTO_RELEASE_OBJECT_ID,
          successStatus: NAV_JOB_STATUS_SUCCESS,
        }),
        this.select(this.queries.inProcessJobs, {
          iabcObjectId: NAV_IABC_OBJECT_ID,
          autoReleaseObjectId: NAV_AUTO_RELEASE_OBJECT_ID,
          jqeInProcessStatus: NAV_JQE_STATUS_IN_PROCESS,
          logInProcessStatus: NAV_JOB_STATUS_IN_PROCESS,
        }),
        this.select(this.queries.pendingStagingCount, {
          pendingStatus: NAV_STAGING_STATUS_PENDING_PROMOTION,
        }),
      ]);
      return mapJobQueueState(autoRelease[0], inProcess, staging[0]);
    } catch (err) {
      return this.degrade('job-queue state', err, this.stub.getJobQueueState());
    }
  }

  async getNewestDtcShipmentAt(): Promise<string | null> {
    try {
      const rows = await this.select(this.queries.newestDtcShipment);
      return rows[0] ? toIso(rows[0].postedAt) : null;
    } catch (err) {
      return this.degrade('newest DTC shipment', err, this.stub.getNewestDtcShipmentAt());
    }
  }

  async getOutstandingOrderLines(limit: number): Promise<NavOrderLine[]> {
    try {
      const rows = await this.select(this.queries.outstandingOrderLines, { limit });
      return rows.map(mapOrderLine);
    } catch (err) {
      return this.degrade('outstanding order lines', err, this.stub.getOutstandingOrderLines(limit));
    }
  }
  async getShippedOrderLines(limit: number): Promise<NavOrderLine[]> {
    try {
      const rows = await this.select(this.queries.shippedOrderLines, { limit });
      return rows.map(mapOrderLine);
    } catch (err) {
      return this.degrade('shipped order lines', err, this.stub.getShippedOrderLines(limit));
    }
  }
  async getIabcBySku(sku: string): Promise<NavIabcRow[]> {
    try {
      const rows = await this.select(this.queries.iabcAvailability, { sku });
      return rows.map(mapIabcRow);
    } catch (err) {
      return this.degrade('iabc availability', err, this.stub.getIabcBySku(sku));
    }
  }

  // Curated read-only templates only (no arbitrary SQL from callers). Unknown
  // template names return empty, matching the stub.
  async queryReadOnly<T>(templateName: string, params: Record<string, unknown> = {}): Promise<T[]> {
    const sql = (this.queries as unknown as Record<string, string>)[templateName];
    if (sql === undefined) {
      // eslint-disable-next-line no-console
      console.warn(`[nav:live] unknown read-only template "${templateName}"`);
      return [];
    }
    try {
      const rows = await this.select(sql, params);
      return rows as unknown as T[];
    } catch (err) {
      return this.degrade(`read-only template ${templateName}`, err, [] as T[]);
    }
  }
}

// Factory. Returns the REAL client when NAV is configured (a host is present;
// aad-default needs no extra secrets, service-principal reads its AAD fields).
// Otherwise, and whenever NAV is unreachable at query time, the stub answers so
// the app boots and verdicts fall back to 'unknown' rather than crashing. The
// live client connects lazily on first query, never at import time.
export function createNavClient(): NavClient {
  const configured = config.nav.host.length > 0;
  if (!configured) {
    // eslint-disable-next-line no-console
    console.info('[nav] no NAV_HOST configured; using read-only stub client');
    return new NavClientStub();
  }
  // eslint-disable-next-line no-console
  console.info(
    `[nav] live read-only client active (host=${config.nav.host}, db=${config.nav.database}, ` +
      `company=${config.nav.company}, auth=${config.nav.authMode})`,
  );
  return new NavClientLive(config.nav);
}
