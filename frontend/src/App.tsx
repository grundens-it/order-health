import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChannelFilter as ChannelFilterValue,
  LeadershipRollup,
  OrderHealth,
  PipelineHealth,
  RemediationRegistry,
} from '@order-health/shared';
import { fetchOrders, fetchPipelines, fetchRemediationRegistry, fetchRollup } from './api';
import { LeadershipStrip } from './components/LeadershipStrip';
import { PipelineStrip } from './components/PipelineStrip';
import { RemediationModal, type RemediationSubject } from './components/RemediationModal';
import { OrderTable } from './components/OrderTable';
import { ChannelFilter } from './components/ChannelFilter';
import { AttentionFilter, type AttentionValue } from './components/AttentionFilter';
import { Toast } from './components/Toast';

// The Order Health tab, ported from demo/order-health-dashboard-demo.html and
// wired to the live read API: leadership rollup, six pipeline-health cards, and the
// per-order lifecycle table with stage dots. The other tabs (Inventory Sync,
// Back-Sync, Warehouse Split, Errors, SQL Console) are middleware deep-links that
// are inert until a deep-link base URL is configured; the outage replay is a
// no-op until we retain snapshot history. Neither fabricates data.

const DEEP_LINK_TABS = ['Inventory Sync', 'Back-Sync', 'Warehouse Split', 'Errors', 'SQL Console'];

// Pipe display names for the remediation modal header.
const PIPE_LABELS: Record<string, string> = {
  inventory_sync: 'Inventory sync',
  back_sync: 'Back-sync',
  price_sync: 'Price sync',
  nav_job_queue: 'NAV job queue',
  shopify_webhook: 'Shopify webhooks',
  allocator: 'Allocator split',
};

export function App(): JSX.Element {
  const [channel, setChannel] = useState<ChannelFilterValue>('all');
  const [attention, setAttention] = useState<AttentionValue>('all');
  const [pipelines, setPipelines] = useState<PipelineHealth[]>([]);
  const [orders, setOrders] = useState<OrderHealth[]>([]);
  const [rollup, setRollup] = useState<LeadershipRollup | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [registry, setRegistry] = useState<RemediationRegistry | null>(null);
  const [remediationSubject, setRemediationSubject] = useState<RemediationSubject | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const flashToast = (msg: string): void => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  };
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // The remediation registry (re-fetched on refresh alongside the snapshot).
  useEffect(() => {
    let cancelled = false;
    fetchRemediationRegistry()
      .then((res) => {
        if (cancelled) return;
        const { as_of: _asOf, ...reg } = res;
        setRegistry(reg);
      })
      .catch(() => {
        // Non-critical: the modal simply shows "no remediation mapped" if it never loads.
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // The three health endpoints. Re-fetched on channel change and on refresh.
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchPipelines(), fetchOrders(channel), fetchRollup()])
      .then(([pipeRes, orderRes, rollupRes]) => {
        if (cancelled) return;
        setPipelines(pipeRes.data);
        setOrders(orderRes.data);
        const { as_of: _rollupTime, ...rollupData } = rollupRes;
        setRollup(rollupData);
        setAsOf(orderRes.as_of ?? pipeRes.as_of);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'failed to load health snapshot');
      });
    return () => {
      cancelled = true;
    };
  }, [channel, refreshKey]);

  const asOfLabel = useMemo(() => {
    if (!asOf) return 'no snapshot yet';
    return `as of ${new Date(asOf).toLocaleString()}`;
  }, [asOf]);

  // Client-side attention filter (needs attention = amber or red) on top of the
  // server-side channel filter (which is wired to /api/health/orders?channel=).
  const visibleOrders = useMemo(() => {
    if (attention === 'all') return orders;
    return orders.filter((o) => o.order_verdict === 'amber' || o.order_verdict === 'red');
  }, [orders, attention]);

  const openPipeRemediation = (pipe: PipelineHealth): void => {
    setRemediationSubject({
      subjectKind: 'pipe',
      subjectKey: pipe.pipe,
      label: PIPE_LABELS[pipe.pipe] ?? pipe.pipe,
    });
  };

  const refresh = (): void => {
    setRefreshKey((k) => k + 1);
    flashToast('Snapshot refreshed');
  };

  return (
    <>
      <div className="band">
        <div className="band-in">
          <div className="logo">
            <span className="mark">G</span>
            <div>
              GRUNDENS
              <small>Order health observability</small>
            </div>
          </div>
          <div className="band-spacer" />
          <div className="controls" style={{ margin: 0 }}>
            <button
              className="btn warn"
              title="Outage replay needs retained snapshot history, which we do not have yet (coming soon)"
              onClick={() => flashToast('Outage replay is not wired yet (needs snapshot history)')}
            >
              Replay outage
            </button>
            <button className="btn" onClick={refresh}>
              Refresh snapshot
            </button>
          </div>
          <div className="asof">
            Snapshot <b>{asOfLabel}</b>
            <br />
            <span>aggregator cadence 3 min, inventory layer ~2 h</span>
          </div>
        </div>
      </div>

      <div className="demo-note">
        <b>Live read-only view.</b> NAV-sourced signals are graded from the latest snapshot;
        middleware-sourced signals are stubbed until DevOps provisions them and render as
        <b> pending source</b>, never as a fabricated number or a false green.
      </div>

      <div className="wrap">
        <div className="tabs">
          <div className="tab on">Order Health</div>
          {DEEP_LINK_TABS.map((t) => (
            <div
              className="tab"
              key={t}
              title="configure middleware deep-link"
              onClick={() => flashToast('Deep-link base URL is not configured yet')}
            >
              {t}
            </div>
          ))}
        </div>

        {error && (
          <div className="sec">
            <span className="aux">Backend unreachable: {error}. Start the backend on :8080.</span>
          </div>
        )}

        <div className="sec">
          <h2>Leadership rollup</h2>
          <div className="rule" />
        </div>
        <LeadershipStrip rollup={rollup} />

        <PipelineStrip pipelines={pipelines} onRemediate={openPipeRemediation} />

        <div className="sec">
          <h2>Order lifecycle</h2>
          <div className="rule" />
        </div>
        <div className="controls">
          <ChannelFilter value={channel} onChange={setChannel} />
          <AttentionFilter value={attention} onChange={setAttention} />
          <span className="count">
            {visibleOrders.length} order{visibleOrders.length === 1 ? '' : 's'} shown
          </span>
        </div>
        <OrderTable
          orders={visibleOrders}
          onRemediate={setRemediationSubject}
          onInert={(label) => flashToast(`${label}: configure the middleware deep-link base URL first`)}
        />

        <div className="legend">
          <span className="li">
            <span className="dot g" /> On time
          </span>
          <span className="li">
            <span className="dot a" /> In flight, within SLO
          </span>
          <span className="li">
            <span className="dot r" /> Errored / past SLO
          </span>
          <span className="li">
            <span className="dot pending" /> Not started
          </span>
          <span className="li">
            <span className="dot na" /> No leg (wholesale)
          </span>
          <span className="li" style={{ marginLeft: 'auto' }}>
            Shape encodes state too, not color alone.
          </span>
        </div>

        <div className="foot-src">
          Sources unified by the aggregator: <code>inventory_sync</code>, <code>price_sync</code>,{' '}
          <code>nav_shipment_sync</code>, <code>shopify_webhook_event</code>,{' '}
          <code>warehouse_allocation_log</code>, NAV staging and shipment tables, the IABC
          watermark, and the existing NAV codeunit instrumentation. DTC correlates on{' '}
          <code>[WebId]</code>; wholesale is keyed on NAV order no (no Shopify leg).
        </div>
      </div>

      <RemediationModal
        subject={remediationSubject}
        registry={registry}
        onClose={() => setRemediationSubject(null)}
      />
      <Toast message={toast} />
    </>
  );
}
