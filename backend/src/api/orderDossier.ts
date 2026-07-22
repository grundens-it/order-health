// Single-order dossier (ADR-0012).
//
// GET /api/orders/:orderNo/dossier composes every source we can reach for ONE order
// into a single payload under one as_of. It resolves the order across the OPEN Sales
// Header/Line AND the POSTED Sales Shipment Header/Line, so a shipped or closed order
// (gone from the open board) is still fully answerable, and a base like SP-322263 fans
// out to all of its legs (SP-322263-1 / -2). Each line carries its per-system status
// (ordered / shipped / invoiced / outstanding), and the order rolls up to one overall
// status. Read-only everywhere. PII is stripped at THIS seam: no customer name,
// address, email, or [Source Name] enters the payload.
//
// assembleDossier is a pure function over already-fetched source data, so it is unit
// testable without a live NAV or middleware. buildOrderDossier is the I/O glue.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  Channel,
  DossierSourceStatus,
  OrderDossier,
  OrderDossierAvailabilityRow,
  OrderDossierLine,
  OrderDossierResponse,
  OrderDossierShopify,
  OrderHandoffOwner,
  OrderLineStatus,
  OrderOverallStatus,
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
  NavOrderComposite,
  NavOrderCompositeLine,
  NavTraceRow,
} from '../sources/navClient';

// Holman Logistics = Lanham EDI trade partner 2538727140; its fulfillment message is
// the 940. sent + 997-acked = proof the order is in Holman's court.
const HOLMAN_TRADE_PARTNER = '2538727140';
const HOLMAN_EDI_DOC = '940';

// The two warehouses we surface availability for. HF1FTZ is Holman (the DTC 3PL); TAC
// is the deprecating on-prem location. Anything else is not shown.
const DOSSIER_LOCATIONS = new Set(['HF1FTZ', 'TAC']);

const DOSSIER_MW_TIMEOUT_MS = 6000;
const ONE_DAY_MS = 86_400_000;

// The raw, already-fetched inputs the pure assembler folds into a dossier.
export interface DossierInputs {
  orderNo: string; // the resolved base order number
  nowMs: number;
  composite: NavOrderComposite;
  edi: NavEdiSendRow[];
  holds: NavHoldRow[];
  trace: NavTraceRow[];
  availability: NavIabcRow[];
  shopify: OrderDossierShopify | null;
  sources: Record<string, DossierSourceStatus>;
}

function ageDaysFrom(orderAt: string | null, nowMs: number): number {
  if (orderAt === null) return 0;
  const t = Date.parse(orderAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / ONE_DAY_MS));
}

function traceShowsAutoReleaseSkip(trace: NavTraceRow[]): boolean {
  return trace.some((r) => {
    const hay = `${r.decisionPoint ?? ''} ${r.branchTaken ?? ''} ${r.detail ?? ''}`.toLowerCase();
    return hay.includes('noholdnorelease') || hay.includes('auto-release skipped') || hay.includes('el- skip');
  });
}

// Roll one composite line up to a per-system status.
function lineStatusOf(line: NavOrderCompositeLine, hasStock: boolean): OrderLineStatus {
  const shipped = line.shipped ?? 0;
  const invoiced = line.invoiced ?? 0;
  const outstanding = line.outstanding ?? 0;
  if (line.source === 'shipped') return invoiced > 0 ? 'invoiced' : 'shipped';
  // Open line:
  if (outstanding <= 0 && shipped > 0) return invoiced > 0 ? 'invoiced' : 'shipped';
  if (shipped > 0 && outstanding > 0) return 'partial';
  // Nothing shipped, still outstanding: backorder only if no stock anywhere.
  return hasStock ? 'outstanding' : 'backorder';
}

// Pure. Fold the fetched source data into the dossier, roll up each line's status and
// the overall order status, and stamp the handoff verdict. This is the single point
// where PII is excluded: only the fields named below are copied.
export function assembleDossier(input: DossierInputs): OrderDossier {
  const { composite, edi, holds, trace, availability } = input;

  // Availability by SKU, for the backorder-vs-outstanding call and the hasStock fact.
  const availableBySku = new Map<string, number>();
  for (const a of availability) {
    if (a.sku === null || a.available === null) continue;
    availableBySku.set(a.sku, (availableBySku.get(a.sku) ?? 0) + a.available);
  }
  const skuHasStock = (sku: string | null): boolean =>
    sku !== null && (availableBySku.get(sku) ?? 0) > 0;

  // Per-line rollup.
  const lines: OrderDossierLine[] = composite.lines.map((l) => ({
    leg: l.orderNo,
    sku: l.sku,
    description: l.description,
    location: l.location,
    ordered: l.ordered,
    shipped: l.shipped,
    invoiced: l.invoiced,
    outstanding: l.outstanding,
    unit_price: l.unitPrice === null ? null : String(l.unitPrice),
    status: input.shopify?.cancelled === true ? 'canceled' : lineStatusOf(l, skuHasStock(l.sku)),
  }));

  // Overall order status.
  const anyOutstanding = composite.lines.some((l) => l.source === 'open' && (l.outstanding ?? 0) > 0);
  const anyShipped = composite.lines.some((l) => (l.shipped ?? 0) > 0 && l.source === 'shipped');
  let orderStatus: OrderOverallStatus;
  if (input.shopify?.cancelled === true) orderStatus = 'canceled';
  else if (!composite.found && input.shopify === null) orderStatus = 'not_found';
  else if (anyOutstanding && anyShipped) orderStatus = 'partial';
  else if (anyOutstanding) orderStatus = 'in_progress';
  else if (anyShipped) orderStatus = 'shipped';
  else orderStatus = composite.found ? 'in_progress' : 'not_found';

  // Identity from the primary leg: prefer an open leg, else the first posted leg.
  const openLeg = composite.legs.find((l) => l.presence === 'open') ?? null;
  const primary = openLeg ?? composite.legs[0] ?? null;
  const identity =
    primary === null
      ? null
      : {
          channel: (primary.webOrder === 1 ? 'dtc' : primary.webOrder === 0 ? 'wholesale' : null) as Channel | null,
          nav_order_no: primary.orderNo,
          shopify_order_id: primary.webId,
          shopify_order_name: null, // the "#1024" label is not on the NAV header; omitted
          order_at: primary.orderDate,
          released: primary.navStatus === null ? null : primary.navStatus === 1,
          preseason: primary.preseason,
          in_open_board: composite.legs.some((l) => l.presence === 'open'),
        };

  // Holman 940 handoff facts.
  const holman940 = edi.filter((e) => e.tradePartner === HOLMAN_TRADE_PARTNER && e.ediDoc === HOLMAN_EDI_DOC);
  const ediSent = holman940.some((e) => e.sent === 1);
  const ediAcked = holman940.some((e) => e.groupAck === 1);
  const ediDocExists = holman940.length > 0;
  const activeHold = holds.find((h) => h.released === 0) ?? null;

  // The verdict. A shipped or cancelled order short-circuits (it is done, nothing to
  // chase). Otherwise the SAME classifyHandoff the board uses explains an open order.
  let handoff: OrderDossier['handoff'];
  if (orderStatus === 'shipped') {
    handoff = { state: 'shipped', owner: 'none', reason: 'Every line has shipped from NAV.', label: ORDER_HANDOFF_LABEL.shipped, verdict: 'green' };
  } else if (orderStatus === 'canceled') {
    handoff = { state: 'canceled', owner: 'none', reason: 'Order was cancelled in Shopify.', label: ORDER_HANDOFF_LABEL.canceled, verdict: 'green' };
  } else if (orderStatus === 'not_found') {
    handoff = null;
  } else {
    const hasStock = composite.lines.some((l) => l.source === 'open' && (l.outstanding ?? 0) > 0 && skuHasStock(l.sku));
    const ageDays = ageDaysFrom(primary?.orderDate ?? null, input.nowMs);
    const r = classifyHandoff({
      isPreseason: composite.legs.some((l) => l.preseason === true),
      released: composite.legs.some((l) => l.navStatus === 1),
      ediSent,
      ediAcked,
      ediDocExists,
      activeHoldReason: activeHold?.holdReasonCode ?? null,
      autoReleaseSkipped: traceShowsAutoReleaseSkip(trace),
      hasStock,
      ageDays,
    });
    handoff = {
      state: r.state,
      owner: r.owner,
      reason: r.reason,
      label: ORDER_HANDOFF_LABEL[r.state],
      verdict: (r.verdict === 'excluded' ? 'green' : r.verdict) as Verdict,
    };
  }

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

  return {
    order_no: input.orderNo,
    as_of: new Date(input.nowMs).toISOString(),
    order_status: orderStatus,
    legs: composite.legs.map((l) => ({
      order_no: l.orderNo,
      presence: l.presence,
      nav_status: l.navStatus,
      shipped_at: l.shippedAt,
    })),
    identity,
    handoff,
    lines,
    edi: ediBlock,
    holds: holds.map((h) => ({
      reason_code: h.holdReasonCode,
      owner: (h.holdReasonCode !== null ? holdOwnerFor(h.holdReasonCode) : 'none') as OrderHandoffOwner,
      hold_date: h.holdDate,
      released: h.released,
    })),
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

// One read-only middleware GET for the dossier fan-out. Never throws.
async function middlewareGet(path: string): Promise<{ status: DossierSourceStatus; data: unknown }> {
  if (config.middleware.baseUrl.length === 0) return { status: 'degraded', data: null };
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.middleware.authToken.length > 0) headers.Authorization = `Bearer ${config.middleware.authToken}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOSSIER_MW_TIMEOUT_MS);
  try {
    const res = await fetch(buildUrl(config.middleware.baseUrl, path), { method: 'GET', headers, signal: controller.signal });
    if (!res.ok) return { status: res.status === 404 ? 'not_found' : 'degraded', data: null };
    const json = await res.json().catch(() => null);
    return { status: 'ok', data: json };
  } catch {
    return { status: 'degraded', data: null };
  } finally {
    clearTimeout(timer);
  }
}

async function guarded<T>(label: string, p: Promise<T>, fallback: T, sources: Record<string, DossierSourceStatus>): Promise<T> {
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
// fan-out; each source guarded.
export async function buildOrderDossier(nav: NavClient, orderNo: string): Promise<OrderDossier> {
  const sources: Record<string, DossierSourceStatus> = {};
  const nowMs = Date.now();
  const base = orderNo.trim().toUpperCase().replace(/-\d+$/, '');

  const composite = await guarded(
    'nav_order',
    nav.getOrderComposite(orderNo),
    { base, found: false, legs: [], lines: [] } as NavOrderComposite,
    sources,
  );
  if (sources.nav_order === 'ok' && !composite.found) sources.nav_order = 'not_found';

  // Per-leg NAV reads (EDI 940, holds, allocator trace), merged across all legs.
  const legNos = composite.legs.map((l) => l.orderNo);
  const legReads = await Promise.all(
    legNos.map((leg) =>
      Promise.all([
        guarded(`nav_edi:${leg}`, nav.getEdiSendStatus(leg), [] as NavEdiSendRow[], sources),
        guarded(`nav_holds:${leg}`, nav.getOrderHolds(leg), [] as NavHoldRow[], sources),
        guarded(`nav_allocator:${leg}`, nav.getSplitShipTrace(leg), [] as NavTraceRow[], sources),
      ]),
    ),
  );
  const edi = legReads.flatMap((r) => r[0]);
  const holds = legReads.flatMap((r) => r[1]);
  const trace = legReads.flatMap((r) => r[2]);
  // Collapse the per-leg statuses into three summary keys for the UI.
  // Empty-array .every() is vacuously true, so the no-legs case MUST be checked first
  // or a lookup that found nothing reports every NAV read as a healthy "ok".
  const rollUp = (prefix: string): DossierSourceStatus =>
    legNos.length === 0 ? 'not_found' : legNos.every((l) => sources[`${prefix}:${l}`] === 'ok') ? 'ok' : 'degraded';
  sources.nav_edi = rollUp('nav_edi');
  sources.nav_holds = rollUp('nav_holds');
  sources.nav_allocator = rollUp('nav_allocator');
  for (const l of legNos) {
    delete sources[`nav_edi:${l}`];
    delete sources[`nav_holds:${l}`];
    delete sources[`nav_allocator:${l}`];
  }

  // Availability for the outstanding open SKUs.
  const skus = [...new Set(composite.lines.filter((l) => l.source === 'open' && (l.outstanding ?? 0) > 0).map((l) => l.sku).filter((s): s is string => s !== null))];
  const availability: NavIabcRow[] = [];
  if (skus.length > 0) {
    const perSku = await Promise.all(skus.map((sku) => guarded(`nav_iabc:${sku}`, nav.getIabcBySku(sku), [] as NavIabcRow[], sources)));
    for (const rows of perSku) availability.push(...rows);
    sources.nav_availability = skus.every((s) => sources[`nav_iabc:${s}`] === 'ok') ? 'ok' : 'degraded';
    for (const s of skus) delete sources[`nav_iabc:${s}`];
  } else {
    sources.nav_availability = 'not_found';
  }

  // Shopify order via the middleware, keyed on the numeric Shopify order id from any
  // leg. Normalized to line items + money + cancel status (no customer block).
  let shopify: OrderDossierShopify | null = null;
  const shopifyId = composite.legs.map((l) => l.webId).find((w) => w !== null && /^\d+$/.test(w)) ?? null;
  if (shopifyId !== null) {
    const r = await middlewareGet(`/api/shopify/order/${shopifyId}`);
    sources.shopify_order = r.status;
    if (r.status === 'ok') shopify = buildOrderInfo(r.data);
  } else {
    sources.shopify_order = 'not_found';
  }

  return assembleDossier({ orderNo: base, nowMs, composite, edi, holds, trace, availability, shopify, sources });
}

export async function registerOrderDossierRoute(app: FastifyInstance): Promise<void> {
  const nav = createNavClient();
  app.get(
    '/api/orders/:orderNo/dossier',
    async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const principal = requireRole(req, reply, [APP_ROLES.operator, APP_ROLES.admin]);
      if (principal === null) return reply;
      const orderNo = (req.params as { orderNo: string }).orderNo.trim();
      if (orderNo.length === 0) return reply.code(400).send({ error: 'orderNo is required' });
      const dossier = await buildOrderDossier(nav, orderNo);
      const body: OrderDossierResponse = { as_of: dossier.as_of, dossier };
      return reply.send(body);
    },
  );
}
