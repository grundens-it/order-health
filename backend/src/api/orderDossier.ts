// Single-order dossier (ADR-0012).
//
// GET /api/orders/:orderNo/dossier composes every source we can reach for ONE order
// into a single payload under one as_of, stamped with the SAME classifyHandoff verdict
// the board uses, so the single-order view and the board can never disagree about the
// same order. Read-only everywhere. PII is stripped at THIS seam: no customer name,
// address, email, or [Source Name] ever enters the payload (see assembleDossier).
//
// The assembly is a pure function over already-fetched source data, so it is unit
// testable without a live NAV or middleware. The route is the I/O glue: it fans out to
// the existing read methods in parallel, each guarded so one failing source degrades
// its block rather than failing the whole dossier.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  Channel,
  DossierSourceStatus,
  OrderDossier,
  OrderDossierAvailabilityRow,
  OrderDossierResponse,
  OrderDossierShopify,
  OrderHandoffOwner,
  Verdict,
} from '@order-health/shared';
import { APP_ROLES, ORDER_HANDOFF_LABEL } from '@order-health/shared';
import { config } from '../config';
import { requireRole } from '../auth/context';
import { buildUrl } from '../sources/middlewareClient';
import { buildOrderInfo } from './orderLineItems';
import { classifyHandoff, holdOwnerFor } from '../aggregator/orderHandoffClass';
import { createNavClient } from '../sources/navClient';
import type {
  NavClient,
  NavEdiSendRow,
  NavHoldRow,
  NavIabcRow,
  NavOrderLifecycleRow,
  NavOrderLine,
  NavTraceRow,
} from '../sources/navClient';

// Holman Logistics = Lanham EDI trade partner 2538727140; its fulfillment message is
// the 940. sent + 997-acked = proof the order is in Holman's court.
const HOLMAN_TRADE_PARTNER = '2538727140';
const HOLMAN_EDI_DOC = '940';

// The two warehouses we surface availability for. HF1FTZ is Holman (the DTC 3PL); TAC
// is the deprecating on-prem location. Anything else is not shown.
const DOSSIER_LOCATIONS = new Set(['HF1FTZ', 'TAC']);

// Per-source timeout for the middleware reads in the dossier fan-out. A stalled source
// degrades its block; it never hangs the dossier.
const DOSSIER_MW_TIMEOUT_MS = 6000;

const ONE_DAY_MS = 86_400_000;

// The raw, already-fetched inputs the pure assembler folds into a dossier. Each block
// is optional / nullable; a source that failed to read is represented by its status in
// `sources` and an empty or null block, never by a thrown error.
export interface DossierInputs {
  orderNo: string;
  nowMs: number;
  lifecycle: NavOrderLifecycleRow | null;
  outstandingLines: NavOrderLine[];
  shippedLines: NavOrderLine[];
  edi: NavEdiSendRow[];
  holds: NavHoldRow[];
  trace: NavTraceRow[];
  availability: NavIabcRow[];
  shopify: OrderDossierShopify | null;
  sources: Record<string, DossierSourceStatus>;
}

function ageDaysFrom(orderAt: string | null | undefined, nowMs: number): number {
  if (orderAt === null || orderAt === undefined) return 0;
  const t = Date.parse(orderAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / ONE_DAY_MS));
}

// The autorelease skip (EL- orders, pending the CU 5790 fix) shows up in the Split Ship
// Trace as an EL.NoHoldNoRelease decision. Match it permissively across the columns the
// allocator writes, so a wording change does not silently drop the signal.
function traceShowsAutoReleaseSkip(trace: NavTraceRow[]): boolean {
  return trace.some((r) => {
    const hay = `${r.decisionPoint ?? ''} ${r.branchTaken ?? ''} ${r.detail ?? ''}`.toLowerCase();
    return hay.includes('noholdnorelease') || hay.includes('auto-release skipped') || hay.includes('el- skip');
  });
}

// Pure. Fold the fetched source data into the dossier and stamp the handoff verdict.
// This is the single point where PII is excluded: only the fields named below are
// copied, so a customer name / address / email cannot leak even if a source row
// carries one. The allocator detail is passed through because getSplitShipTrace never
// selects [Source Name] upstream (enforced there).
export function assembleDossier(input: DossierInputs): OrderDossier {
  const { lifecycle, outstandingLines, shippedLines, edi, holds, trace, availability } = input;

  const holman940 = edi.filter(
    (e) => e.tradePartner === HOLMAN_TRADE_PARTNER && e.ediDoc === HOLMAN_EDI_DOC,
  );
  const ediSent = holman940.some((e) => e.sent === 1);
  const ediAcked = holman940.some((e) => e.groupAck === 1);
  const ediDocExists = holman940.length > 0;

  const activeHold = holds.find((h) => h.released === 0) ?? null;
  const activeHoldReason = activeHold?.holdReasonCode ?? null;

  const availableBySku = new Map<string, number>();
  for (const a of availability) {
    if (a.sku === null || a.available === null) continue;
    availableBySku.set(a.sku, (availableBySku.get(a.sku) ?? 0) + a.available);
  }
  const lineSkus = outstandingLines.map((l) => l.sku).filter((s): s is string => s !== null);
  const hasStock = lineSkus.some((s) => (availableBySku.get(s) ?? 0) > 0);

  const ageDays = ageDaysFrom(lifecycle?.orderAt ?? lifecycle?.shopifyOrderAt ?? null, input.nowMs);

  const handoffResult = classifyHandoff({
    isPreseason: lifecycle?.isPreseason === true,
    released: lifecycle?.navStatus === 1,
    ediSent,
    ediAcked,
    ediDocExists,
    activeHoldReason,
    autoReleaseSkipped: traceShowsAutoReleaseSkip(trace),
    hasStock,
    ageDays,
  });

  const identity =
    lifecycle === null
      ? null
      : {
          channel: lifecycle.channel as Channel,
          nav_order_no: lifecycle.navOrderNo,
          shopify_order_id: lifecycle.webId,
          shopify_order_name: lifecycle.shopifyOrderName, // "#1024", never a customer name
          order_at: lifecycle.orderAt ?? lifecycle.shopifyOrderAt ?? null,
          released: lifecycle.navStatus === null ? null : lifecycle.navStatus === 1,
          preseason: lifecycle.isPreseason ?? null,
          in_open_board: true,
        };

  const availabilityRows: OrderDossierAvailabilityRow[] = availability
    .filter((a) => a.sku !== null && a.location !== null && DOSSIER_LOCATIONS.has(a.location))
    .map((a) => ({
      sku: a.sku as string,
      location: a.location as string,
      channel: a.channel,
      on_hand: a.onHand,
      available: a.available,
      earliest_ship_date: a.earliestShipDate,
    }));

  const ediBlock = ediDocExists
    ? {
        present: true,
        sent: ediSent,
        acked: ediAcked,
        sent_date: holman940.find((e) => e.sentDate !== null)?.sentDate ?? null,
        created_date: holman940.find((e) => e.createdDate !== null)?.createdDate ?? null,
      }
    : null;

  const holdRows = holds.map((h) => ({
    reason_code: h.holdReasonCode,
    owner: (h.holdReasonCode !== null ? holdOwnerFor(h.holdReasonCode) : 'none') as OrderHandoffOwner,
    hold_date: h.holdDate,
    released: h.released,
  }));

  return {
    order_no: input.orderNo,
    as_of: new Date(input.nowMs).toISOString(),
    identity,
    handoff: {
      state: handoffResult.state,
      owner: handoffResult.owner,
      reason: handoffResult.reason,
      label: ORDER_HANDOFF_LABEL[handoffResult.state],
      verdict: (handoffResult.verdict === 'excluded' ? 'green' : handoffResult.verdict) as Verdict,
    },
    lines: outstandingLines.map((l) => ({
      sku: l.sku,
      location: l.location,
      outstanding: l.outstandingQty,
    })),
    shipped_lines: shippedLines.map((l) => ({
      sku: l.sku,
      location: l.location,
      outstanding: l.outstandingQty,
    })),
    edi: ediBlock,
    holds: holdRows,
    allocator: trace.map((r) => ({
      entry_at: r.entryAt,
      decision_point: r.decisionPoint,
      item_no: r.itemNo,
      location_code: r.locationCode,
      branch_taken: r.branchTaken,
      detail: r.detail,
    })),
    availability: availabilityRows,
    shopify: input.shopify,
    sources: input.sources,
  };
}

// One read-only middleware GET for the dossier fan-out. Returns the parsed data or
// null, plus a source status. Never throws; a failure is reported as 'degraded'.
async function middlewareGet(
  path: string,
): Promise<{ status: DossierSourceStatus; data: unknown }> {
  if (config.middleware.baseUrl.length === 0) return { status: 'degraded', data: null };
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.middleware.authToken.length > 0) {
    headers.Authorization = `Bearer ${config.middleware.authToken}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOSSIER_MW_TIMEOUT_MS);
  try {
    const res = await fetch(buildUrl(config.middleware.baseUrl, path), {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!res.ok) return { status: res.status === 404 ? 'not_found' : 'degraded', data: null };
    const json = await res.json().catch(() => null);
    return { status: 'ok', data: json };
  } catch {
    return { status: 'degraded', data: null };
  } finally {
    clearTimeout(timer);
  }
}

// Settle a promise into a value plus a source status, so one failing NAV read degrades
// its block instead of rejecting the whole fan-out.
async function guarded<T>(
  label: string,
  p: Promise<T>,
  fallback: T,
  sources: Record<string, DossierSourceStatus>,
): Promise<T> {
  try {
    const v = await p;
    sources[label] = 'ok';
    return v;
  } catch {
    sources[label] = 'degraded';
    return fallback;
  }
}

// Fetch every source for one order and assemble the dossier. Read-only; parallel
// fan-out; each source guarded. Exposed for the route and reused by tests via the
// injected NavClient.
export async function buildOrderDossier(nav: NavClient, orderNo: string): Promise<OrderDossier> {
  const sources: Record<string, DossierSourceStatus> = {};
  const nowMs = Date.now();

  // NAV reads. The lifecycle board is the whole open-orders set; we filter to this
  // order. An order absent from the board (closed / fully shipped) yields a null
  // identity and is marked not_found, but the per-order NAV reads still run.
  const [board, outstanding, shipped, edi, holds, trace] = await Promise.all([
    guarded('nav_lifecycle', nav.getOrderLifecycleRows(), [] as NavOrderLifecycleRow[], sources),
    guarded('nav_outstanding_lines', nav.getOutstandingOrderLines(5000), [] as NavOrderLine[], sources),
    guarded('nav_shipped_lines', nav.getShippedOrderLines(5000), [] as NavOrderLine[], sources),
    guarded('nav_edi', nav.getEdiSendStatus(orderNo), [] as NavEdiSendRow[], sources),
    guarded('nav_holds', nav.getOrderHolds(orderNo), [] as NavHoldRow[], sources),
    guarded('nav_allocator', nav.getSplitShipTrace(orderNo), [] as NavTraceRow[], sources),
  ]);

  const lifecycle = board.find((r) => r.navOrderNo === orderNo) ?? null;
  if (sources.nav_lifecycle === 'ok' && lifecycle === null) sources.nav_lifecycle = 'not_found';

  const outstandingLines = outstanding.filter((l) => l.orderNo === orderNo);
  const shippedLines = shipped.filter((l) => l.orderNo === orderNo);

  // Availability: one IABC read per distinct SKU on the order's outstanding lines.
  const skus = [...new Set(outstandingLines.map((l) => l.sku).filter((s): s is string => s !== null))];
  const availability: NavIabcRow[] = [];
  if (skus.length > 0) {
    const perSku = await Promise.all(
      skus.map((sku) => guarded(`nav_iabc:${sku}`, nav.getIabcBySku(sku), [] as NavIabcRow[], sources)),
    );
    for (const rows of perSku) availability.push(...rows);
    // Collapse the per-SKU statuses into one availability status for the UI.
    sources.nav_availability = skus.every((s) => sources[`nav_iabc:${s}`] === 'ok') ? 'ok' : 'degraded';
  } else {
    sources.nav_availability = 'not_found';
  }

  // Shopify order via the middleware, keyed on the numeric Shopify order id if the
  // order is in the board. Normalized server-side to line items + money only (no
  // customer block) by buildOrderInfo.
  let shopify: OrderDossierShopify | null = null;
  const shopifyId = lifecycle?.webId ?? null;
  if (shopifyId !== null && /^\d+$/.test(shopifyId)) {
    const r = await middlewareGet(`/api/shopify/order/${shopifyId}`);
    sources.shopify_order = r.status;
    if (r.status === 'ok') shopify = buildOrderInfo(r.data);
  } else {
    sources.shopify_order = 'not_found';
  }

  return assembleDossier({
    orderNo,
    nowMs,
    lifecycle,
    outstandingLines,
    shippedLines,
    edi,
    holds,
    trace,
    availability,
    shopify,
    sources,
  });
}

export async function registerOrderDossierRoute(app: FastifyInstance): Promise<void> {
  // Its own read-only NAV client, matching the diagnostics routes' pattern.
  const nav = createNavClient();

  // GET /api/orders/:orderNo/dossier -> the composed single-order dossier. Operator OR
  // Admin, read-only. Everything here is a read; nothing mutates NAV or the middleware.
  app.get(
    '/api/orders/:orderNo/dossier',
    async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const principal = requireRole(req, reply, [APP_ROLES.operator, APP_ROLES.admin]);
      if (principal === null) return reply;
      const orderNo = (req.params as { orderNo: string }).orderNo.trim();
      if (orderNo.length === 0) {
        return reply.code(400).send({ error: 'orderNo is required' });
      }
      const dossier = await buildOrderDossier(nav, orderNo);
      const body: OrderDossierResponse = { as_of: dossier.as_of, dossier };
      return reply.send(body);
    },
  );
}
