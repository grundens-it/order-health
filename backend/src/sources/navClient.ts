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

export interface NavClient {
  getInventoryWatermarkState(): Promise<NavWatermarkState>;
  getRecentInventoryWalks(limit: number): Promise<InventoryWalk[]>;
  getOrderLifecycleRows(): Promise<NavOrderLifecycleRow[]>;
  getRecentShipments(limit: number): Promise<NavShipmentHeader[]>;
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
}

export function buildQueries(company: string): NavQueries {
  const jqLog = navTable(company, 'Job Queue Log Entry');
  const salesHeader = navTable(company, 'Sales Header');
  const staging = navTable(company, 'Sales Header Staging');
  const shipment = navTable(company, 'Sales Shipment Header');

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
