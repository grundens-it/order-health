import { useEffect, useMemo, useState } from 'react';
import type {
  ChannelFilter as ChannelFilterValue,
  LeadershipRollup,
  LifecycleStage,
  OrderHealth,
  PipelineHealth,
  RemediationRegistry,
} from '@order-health/shared';
import { APP_ROLES, detectRemediationTool } from '@order-health/shared';
import { ApiError, fetchAuthMe, fetchOrders, fetchPipelines, fetchRemediationRegistry, fetchRollup } from './api';
import { AdminPanel } from './components/AdminPanel';
import { LeadershipStrip, type DrillTarget } from './components/LeadershipStrip';
import { PipelineStrip } from './components/PipelineStrip';
import { RemediationModal, type RemediationSubject } from './components/RemediationModal';
import { InventoryPanel } from './components/InventoryPanel';
import { BackSyncPanel } from './components/BackSyncPanel';
import { PriceSyncPanel } from './components/PriceSyncPanel';
import { JobQueuePanel } from './components/JobQueuePanel';
import { ShopifyWebhookPanel } from './components/ShopifyWebhookPanel';
import { AllocatorPanel } from './components/AllocatorPanel';
import { OrderTable } from './components/OrderTable';
import { ChannelFilter } from './components/ChannelFilter';

// Tabbed shell, matching the demo: "Order Health" is the primary view (leadership
// glance + pipeline cards + the filterable order lifecycle table); each pipe has
// its own deep-dive tab so no single panel buries the rest. The Admin tab (arm /
// disarm executable remediation) renders only for Admins.

type TabKey =
  | 'orderhealth'
  | 'inventory'
  | 'backsync'
  | 'pricesync'
  | 'jobqueue'
  | 'webhooks'
  | 'warehouse'
  | 'admin';

const INTERNAL_TABS: ReadonlyArray<readonly [TabKey, string]> = [
  ['orderhealth', 'Order Health'],
  ['inventory', 'Inventory Sync'],
  ['backsync', 'Back-Sync'],
  ['pricesync', 'Price Sync'],
  ['jobqueue', 'Job Queue'],
  ['webhooks', 'Webhooks'],
  ['warehouse', 'Warehouse Split'],
];

const STAGE_OPTIONS: ReadonlyArray<readonly [LifecycleStage, string]> = [
  ['shopify_order', 'Shopify order'],
  ['allocator_split', 'Allocator split'],
  ['nav_staging', 'NAV staging'],
  ['nav_promotion', 'NAV promotion'],
  ['awaiting_ship', 'Awaiting ship'],
  ['nav_shipment', 'NAV shipment'],
  ['back_sync', 'Back-sync'],
  ['complete', 'Complete'],
];

type RowCount = 25 | 50 | 100 | 'all';
const ROW_COUNTS: readonly RowCount[] = [25, 50, 100, 'all'];

// Unit 4 "why" builders. Turn a subject's verdict + detail into a one-line reason
// plus supporting rows the modal shows FIRST. Read-only, pure UI derivation.
function humanAgeShort(s: number | null): string {
  if (s === null) return 'n/a';
  const d = s / 86400;
  if (d >= 1) return `${d.toFixed(1)}d`;
  const h = s / 3600;
  if (h >= 1) return `${h.toFixed(1)}h`;
  return `${Math.round(s / 60)}m`;
}

function pipeWhy(pipe: PipelineHealth, label: string): { why: string; details: { k: string; v: string }[] } {
  const parts: string[] = [];
  if (pipe.freshness_verdict !== 'green' && pipe.freshness_verdict !== 'unknown') {
    parts.push(`freshness ${pipe.freshness_verdict}`);
  }
  if (pipe.liveness_verdict !== 'green' && pipe.liveness_verdict !== 'unknown') {
    parts.push(`liveness ${pipe.liveness_verdict}`);
  }
  const why = `${label} is ${pipe.pipe_verdict}${parts.length > 0 ? ': ' + parts.join(', ') : ''}`;
  const details: { k: string; v: string }[] = [
    { k: 'Freshness', v: pipe.freshness_verdict },
    { k: 'Liveness', v: pipe.liveness_verdict },
  ];
  if (pipe.watermark_lag_s !== null) details.push({ k: 'Watermark lag', v: humanAgeShort(pipe.watermark_lag_s) });
  if (pipe.heartbeat_age_s !== null) details.push({ k: 'Heartbeat age', v: humanAgeShort(pipe.heartbeat_age_s) });
  return { why, details };
}

function orderWhy(o: OrderHealth): { why: string; details: { k: string; v: string }[]; nextStep?: string } {
  const d = o.awaiting_ship_detail ?? null;
  const why = d?.why ?? o.note ?? `${o.current_stage} - ${o.order_verdict}`;
  const details: { k: string; v: string }[] = [
    { k: 'Stage', v: o.current_stage },
    { k: 'Age', v: humanAgeShort(o.oldest_stuck_age_s) },
  ];
  if (d !== null) {
    details.push({ k: 'Classification', v: d.classification });
    if (d.fs_available !== null) details.push({ k: 'FS available', v: String(d.fs_available) });
    if (d.nav_warehouse_on_hand !== null) details.push({ k: 'Warehouse on-hand', v: String(d.nav_warehouse_on_hand) });
    if (d.sample_sku !== null) details.push({ k: 'SKU', v: d.sample_sku });
  }
  // A plain next step for the classifications with no automated tool.
  let nextStep: string | undefined;
  if (o.classification === 'genuine_3pl_delay') nextStep = 'chase the 3PL: the order is in stock and past the SLO.';
  else if (o.classification === 'backordered') nextStep = 'restock the short SKU; no fulfillment can ship missing stock.';
  else if (o.classification === 'orphan_or_return') nextStep = 'no NAV order backs this record; hand it to the returns / data team.';
  return { why, details, nextStep };
}

export function App(): JSX.Element {
  const [tab, setTab] = useState<TabKey>('orderhealth');
  const [channel, setChannel] = useState<ChannelFilterValue>('all');
  const [pipelines, setPipelines] = useState<PipelineHealth[]>([]);
  const [orders, setOrders] = useState<OrderHealth[]>([]);
  const [rollup, setRollup] = useState<LeadershipRollup | null>(null);
  // The rollup snapshot time is still tracked for the fetch flow; the strip no
  // longer displays it (the band's "Snapshot as of" shows it), so only the setter is kept.
  const [, setRollupAsOf] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  // Health-fidelity Unit 7: carry the failure MODE, not just a message, so the
  // banner can tell "backend down / unreachable" apart from "backend up but errored
  // (e.g. DB down)".
  const [error, setError] = useState<{ kind: 'network' | 'http' | 'unknown'; message: string } | null>(null);

  // Order-lifecycle controls (Order Health view).
  const [attention, setAttention] = useState<'all' | 'attn'>('all');
  const [stage, setStage] = useState<LifecycleStage | 'all'>('all');
  const [query, setQuery] = useState('');
  const [rowCount, setRowCount] = useState<RowCount>(50);

  // Unit 7: remediation registry + the subject whose modal is open (null = closed).
  const [registry, setRegistry] = useState<RemediationRegistry | null>(null);
  const [remediationSubject, setRemediationSubject] = useState<RemediationSubject | null>(null);

  // RBAC (issue #96): resolve the principal so the Admin-only arm/disarm panel
  // renders for Admins only. The server is still the real gate on every write.
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchAuthMe()
      .then((me) => {
        if (!cancelled) {
          // Match on the last dotted segment so both 'Admin' and
          // 'OrderHealth.Admin' show the panel (the Entra value can lag).
          const bare = (r: string) => (r.includes('.') ? r.slice(r.lastIndexOf('.') + 1) : r);
          const adminBare = bare(APP_ROLES.admin);
          setIsAdmin(me.roles.some((r) => bare(r) === adminBare));
        }
      })
      .catch(() => {
        // Non-critical: without a resolvable principal the panel simply stays hidden.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchRemediationRegistry()
      .then((res) => {
        if (cancelled) return;
        const { as_of: _asOf, ...reg } = res;
        setRegistry(reg);
      })
      .catch(() => {
        // Non-critical for the read view; the modal shows "no remediation mapped".
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchPipelines(), fetchOrders(channel), fetchRollup()])
      .then(([pipeRes, orderRes, rollupRes]) => {
        if (cancelled) return;
        setPipelines(pipeRes.data);
        setOrders(orderRes.data);
        const { as_of: rollupTime, ...rollupData } = rollupRes;
        setRollup(rollupData);
        setRollupAsOf(rollupTime);
        setAsOf(orderRes.as_of ?? pipeRes.as_of);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setError({ kind: err.kind, message: err.message });
        } else {
          setError({
            kind: 'unknown',
            message: err instanceof Error ? err.message : 'failed to load health snapshot',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [channel]);

  const asOfLabel = useMemo(() => {
    if (!asOf) return 'no snapshot yet';
    return `as of ${new Date(asOf).toLocaleString()}`;
  }, [asOf]);

  const pipeByKey = useMemo(() => {
    const m = new Map<string, PipelineHealth>();
    for (const p of pipelines) m.set(p.pipe, p);
    return m;
  }, [pipelines]);

  // Order lifecycle: apply attention -> stage -> search, then cap the row count.
  const filteredOrders = useMemo(() => {
    let list = orders;
    if (attention === 'attn') {
      list = list.filter((o) => o.order_verdict === 'red' || o.order_verdict === 'amber');
    }
    if (stage !== 'all') list = list.filter((o) => o.current_stage === stage);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (o) =>
          (o.nav_order_no ?? '').toLowerCase().includes(q) ||
          (o.shopify_order_name ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [orders, attention, stage, query]);

  const shownOrders = useMemo(
    () => (rowCount === 'all' ? filteredOrders : filteredOrders.slice(0, rowCount)),
    [filteredOrders, rowCount],
  );

  const PIPE_LABELS: Record<string, string> = {
    inventory_sync: 'Inventory sync',
    back_sync: 'Back-sync',
    price_sync: 'Price sync',
    nav_job_queue: 'NAV job queue',
    shopify_webhook: 'Shopify webhooks',
    allocator: 'Allocator split',
    oos_held: 'OOS-held backlog',
    fs_location_divergence: 'FS-location divergence',
  };
  const openPipeRemediation = (pipe: PipelineHealth): void => {
    // Inspect the observed failure mode (issue #35). When a distinct signal is
    // present the detected tool becomes "Recommended"; otherwise the modal falls
    // back to the static primary. Pure, read-only: NAMES a tool, triggers nothing.
    const detected = detectRemediationTool(pipe.pipe, pipe);
    const w = pipeWhy(pipe, PIPE_LABELS[pipe.pipe] ?? pipe.pipe);
    setRemediationSubject({
      subjectKind: 'pipe',
      subjectKey: pipe.pipe,
      label: PIPE_LABELS[pipe.pipe] ?? pipe.pipe,
      detectedToolId: detected?.toolId,
      detectionReason: detected?.reason,
      verdict: pipe.pipe_verdict,
      why: w.why,
      details: w.details,
    });
  };

  // Clicking an order opens its "why" (always) plus any mapped tool. Unit 4: an
  // FS-floored awaiting_ship order routes to the FS re-floor (subjectKey
  // fs_floor_at_zero), not a fulfillment tool; other orders derive the signal from
  // the stage they are stuck at (matching the registry's signal keys).
  const openOrderRemediation = (o: OrderHealth): void => {
    const signal =
      o.classification === 'fs_floor_at_zero'
        ? 'fs_floor_at_zero'
        : o.classification === 'genuine_3pl_delay'
          ? 'genuine_3pl_delay'
          : o.current_stage === 'back_sync'
            ? 'missed_back_sync'
            : o.current_stage === 'nav_staging'
              ? 'nav_staging_stuck'
              : o.current_stage;
    const w = orderWhy(o);
    setRemediationSubject({
      subjectKind: 'order',
      subjectKey: signal,
      label: o.nav_order_no ?? o.shopify_order_name ?? o.customer_ref ?? 'order',
      verdict: o.order_verdict,
      why: w.why,
      details: w.details,
      nextStep: w.nextStep,
      // Carry the identifiers the read-only 3PL diagnostics need (FO Inspector by
      // Shopify order id; NAV inventory check by the representative SKU).
      orderId: o.shopify_order_id ?? undefined,
      diagSku: o.awaiting_ship_detail?.sample_sku ?? undefined,
    });
  };

  // Unit 5: drill through from a leadership card to the underlying items, carrying
  // the "why". An orders card jumps to the order table filtered to that verdict; the
  // oldest-stuck card opens the oldest red order's why; the inventory card opens its panel.
  const onDrill = (t: DrillTarget): void => {
    if (t.kind === 'inventory_sync') {
      setTab('inventory');
      return;
    }
    if (t.kind === 'orders') {
      setTab('orderhealth');
      setAttention(t.verdict === 'green' ? 'all' : 'attn');
      return;
    }
    // oldest_stuck: jump to the order table and open the oldest red order's why.
    setTab('orderhealth');
    const reds = orders.filter((o) => o.order_verdict === 'red' && o.oldest_stuck_age_s !== null);
    if (reds.length > 0) {
      const oldest = reds.reduce((a, b) => ((b.oldest_stuck_age_s ?? 0) > (a.oldest_stuck_age_s ?? 0) ? b : a));
      openOrderRemediation(oldest);
    }
  };

  return (
    <>
      <div className="band">
        <div className="band-in">
          <div className="logo">
            <span className="mark">G</span>
            <span>
              Order Health
              <small>Grundens observability</small>
            </span>
          </div>
          <div className="band-spacer" />
          <div className="asof">
            Snapshot <b>{asOfLabel}</b>
            <br />
            <span>aggregator cadence: order 2 to 5 min, inventory ~2 h</span>
          </div>
        </div>
      </div>

      <nav className="tabnav" aria-label="Dashboard sections">
        <div className="tabs">
          {INTERNAL_TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`tab${tab === key ? ' on' : ''}`}
              aria-current={tab === key ? 'page' : undefined}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
          {isAdmin && (
            <>
              <span className="tab-sep" aria-hidden="true" />
              <button
                type="button"
                className={`tab${tab === 'admin' ? ' on' : ''}`}
                aria-current={tab === 'admin' ? 'page' : undefined}
                onClick={() => setTab('admin')}
              >
                Admin
              </button>
            </>
          )}
        </div>
      </nav>

      <div className="wrap">
        {error && (
          <div className="sec">
            {error.kind === 'network' ? (
              <span className="aux">
                Backend unreachable: {error.message}. The service is not responding; start the
                backend on :8080.
              </span>
            ) : error.kind === 'http' ? (
              <span className="aux">
                Backend is up but returned an error: {error.message}. The service is running; check
                its dependencies (for example the database) and logs, not its reachability.
              </span>
            ) : (
              <span className="aux">Could not load the health snapshot: {error.message}.</span>
            )}
          </div>
        )}

        {tab === 'orderhealth' && (
          <>
            <LeadershipStrip rollup={rollup} onDrill={onDrill} />
            <PipelineStrip pipelines={pipelines} onRemediate={openPipeRemediation} />

            <div className="sec">
              <h2>Order lifecycle</h2>
              <div className="rule" />
              <span className="aux">click an order for its remediation tool</span>
            </div>
            <div className="controls">
              <ChannelFilter value={channel} onChange={setChannel} />
              <div className="seg" role="group" aria-label="Attention filter">
                <button
                  type="button"
                  className={attention === 'all' ? 'on' : ''}
                  onClick={() => setAttention('all')}
                >
                  All
                </button>
                <button
                  type="button"
                  className={attention === 'attn' ? 'on' : ''}
                  onClick={() => setAttention('attn')}
                >
                  Needs attention
                </button>
              </div>
              <label className="selctl">
                <span className="selctl-l">Stage</span>
                <select
                  value={stage}
                  onChange={(e) => setStage(e.target.value as LifecycleStage | 'all')}
                >
                  <option value="all">All stages</option>
                  {STAGE_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <input
                className="searchctl"
                type="search"
                placeholder="Search order number"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search by order number"
              />
              <div className="seg" role="group" aria-label="Rows shown">
                {ROW_COUNTS.map((n) => (
                  <button
                    key={String(n)}
                    type="button"
                    className={rowCount === n ? 'on' : ''}
                    onClick={() => setRowCount(n)}
                  >
                    {n === 'all' ? 'All' : n}
                  </button>
                ))}
              </div>
              <span className="count">
                showing {shownOrders.length} of {orders.length} orders
              </span>
            </div>
            <OrderTable orders={shownOrders} onSelect={openOrderRemediation} />
          </>
        )}

        {tab === 'admin' && isAdmin && (
          <>
            <div className="sec">
              <h2>Remediation controls</h2>
              <div className="rule" />
              <span className="aux">arm and disarm executable remediation (Admin only)</span>
            </div>
            <AdminPanel />
          </>
        )}

        {tab === 'inventory' && (
          <>
            <div className="sec">
              <h2>Inventory sync</h2>
              <div className="rule" />
              <span className="aux">reference monitor: freshness · liveness · push-outcome</span>
            </div>
            <InventoryPanel pipe={pipeByKey.get('inventory_sync') ?? null} />
          </>
        )}

        {tab === 'backsync' && (
          <>
            <div className="sec">
              <h2>Back-sync</h2>
              <div className="rule" />
              <span className="aux">NAV shipment to Shopify: freshness · liveness · missed shipments</span>
            </div>
            <BackSyncPanel pipe={pipeByKey.get('back_sync') ?? null} />
          </>
        )}

        {tab === 'pricesync' && (
          <>
            <div className="sec">
              <h2>Price sync</h2>
              <div className="rule" />
              <span className="aux">received freshness · syncer liveness</span>
            </div>
            <PriceSyncPanel pipe={pipeByKey.get('price_sync') ?? null} />
          </>
        )}

        {tab === 'jobqueue' && (
          <>
            <div className="sec">
              <h2>NAV job queue</h2>
              <div className="rule" />
              <span className="aux">verdict consumed from middleware, not recomputed</span>
            </div>
            <JobQueuePanel pipe={pipeByKey.get('nav_job_queue') ?? null} />
          </>
        )}

        {tab === 'webhooks' && (
          <>
            <div className="sec">
              <h2>Shopify webhooks</h2>
              <div className="rule" />
              <span className="aux">last received per topic · subscription health</span>
            </div>
            <ShopifyWebhookPanel pipe={pipeByKey.get('shopify_webhook') ?? null} />
          </>
        )}

        {tab === 'warehouse' && (
          <>
            <div className="sec">
              <h2>Warehouse split</h2>
              <div className="rule" />
              <span className="aux">allocator: decision freshness · liveness · split-sanity</span>
            </div>
            <AllocatorPanel pipe={pipeByKey.get('allocator') ?? null} />
          </>
        )}
      </div>

      <RemediationModal
        subject={remediationSubject}
        registry={registry}
        onClose={() => setRemediationSubject(null)}
      />
    </>
  );
}
