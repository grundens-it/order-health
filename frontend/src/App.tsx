import { useEffect, useMemo, useState } from 'react';
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
import { InventoryPanel } from './components/InventoryPanel';
import { BackSyncPanel } from './components/BackSyncPanel';
import { PriceSyncPanel } from './components/PriceSyncPanel';
import { JobQueuePanel } from './components/JobQueuePanel';
import { ShopifyWebhookPanel } from './components/ShopifyWebhookPanel';
import { AllocatorPanel } from './components/AllocatorPanel';
import { OrderTable } from './components/OrderTable';
import { ChannelFilter } from './components/ChannelFilter';
import { RowCountControl, type RowCount } from './components/RowCountControl';
import { StageFilter, type StageFilterValue } from './components/StageFilter';
import { OrderSearch } from './components/OrderSearch';

// The single route: the two-layer shell (pipeline strip on top, order table
// below) with a DTC / wholesale / all channel filter and the snapshot as_of.
export function App(): JSX.Element {
  const [channel, setChannel] = useState<ChannelFilterValue>('all');
  // Order-lifecycle table controls (client-side, over the fetched snapshot):
  // a stage filter, an order-number search, and a row-count cap. Default cap is
  // 50 rows — enough to scan without rendering the whole snapshot at once.
  const [stage, setStage] = useState<StageFilterValue>('all');
  const [orderSearch, setOrderSearch] = useState<string>('');
  const [rowCount, setRowCount] = useState<RowCount>(50);
  const [pipelines, setPipelines] = useState<PipelineHealth[]>([]);
  const [orders, setOrders] = useState<OrderHealth[]>([]);
  const [rollup, setRollup] = useState<LeadershipRollup | null>(null);
  const [rollupAsOf, setRollupAsOf] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Unit 7: the remediation runbook registry (fetched once) + the subject whose
  // modal is currently open (null = closed).
  const [registry, setRegistry] = useState<RemediationRegistry | null>(null);
  const [remediationSubject, setRemediationSubject] = useState<RemediationSubject | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRemediationRegistry()
      .then((res) => {
        if (cancelled) return;
        const { as_of: _asOf, ...reg } = res;
        setRegistry(reg);
      })
      .catch(() => {
        // The registry is non-critical for the read view; the modal simply shows
        // "no remediation mapped" if it never loads.
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
        // The rollup carries as_of inline (single object, not a list); split the
        // headline fields from the envelope-style as_of for the strip.
        const { as_of: rollupTime, ...rollupData } = rollupRes;
        setRollup(rollupData);
        setRollupAsOf(rollupTime);
        // The order snapshot is the freshest signal for the header as_of.
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
  }, [channel]);

  const asOfLabel = useMemo(() => {
    if (!asOf) return 'no snapshot yet';
    return `as of ${new Date(asOf).toLocaleString()}`;
  }, [asOf]);

  // The inventory-sync pipe owns the reference expanded panel (Unit 1).
  const inventoryPipe = useMemo(
    () => pipelines.find((p) => p.pipe === 'inventory_sync') ?? null,
    [pipelines],
  );

  // The back-sync pipe owns the missed-shipments panel (Unit 2).
  const backSyncPipe = useMemo(
    () => pipelines.find((p) => p.pipe === 'back_sync') ?? null,
    [pipelines],
  );

  // Unit 3 pipes: price-sync, NAV job queue, Shopify webhooks.
  const priceSyncPipe = useMemo(
    () => pipelines.find((p) => p.pipe === 'price_sync') ?? null,
    [pipelines],
  );
  const jobQueuePipe = useMemo(
    () => pipelines.find((p) => p.pipe === 'nav_job_queue') ?? null,
    [pipelines],
  );
  const webhookPipe = useMemo(
    () => pipelines.find((p) => p.pipe === 'shopify_webhook') ?? null,
    [pipelines],
  );

  // The allocator pipe owns the Warehouse Split decisions panel (Unit 4).
  const allocatorPipe = useMemo(
    () => pipelines.find((p) => p.pipe === 'allocator') ?? null,
    [pipelines],
  );

  // Derived order-lifecycle rows. The channel filter is already applied upstream
  // (fetchOrders(channel) refetches per channel), so here we compose the three
  // client-side controls in order: stage filter -> order-number search -> row
  // cap. Search matches nav_order_no OR shopify_order_name as a case-insensitive
  // trimmed substring; an empty query is a no-op. The cap is applied last so the
  // count reflects "shown of matched".
  const filteredOrders = useMemo(() => {
    const query = orderSearch.trim().toLowerCase();
    let rows = orders;
    if (stage !== 'all') {
      rows = rows.filter((o) => o.current_stage === stage);
    }
    if (query) {
      rows = rows.filter((o) => {
        const nav = o.nav_order_no?.toLowerCase() ?? '';
        const shop = o.shopify_order_name?.toLowerCase() ?? '';
        return nav.includes(query) || shop.includes(query);
      });
    }
    return rows;
  }, [orders, stage, orderSearch]);

  // Rows actually rendered after the row-count cap ('all' = no cap).
  const shownOrders = useMemo(
    () => (rowCount === 'all' ? filteredOrders : filteredOrders.slice(0, rowCount)),
    [filteredOrders, rowCount],
  );

  // Open the remediation modal for a red/amber pipe (Unit 7).
  const PIPE_LABELS: Record<string, string> = {
    inventory_sync: 'Inventory sync',
    back_sync: 'Back-sync',
    price_sync: 'Price sync',
    nav_job_queue: 'NAV job queue',
    shopify_webhook: 'Shopify webhooks',
    allocator: 'Allocator split',
  };
  const openPipeRemediation = (pipe: PipelineHealth): void => {
    setRemediationSubject({
      subjectKind: 'pipe',
      subjectKey: pipe.pipe,
      label: PIPE_LABELS[pipe.pipe] ?? pipe.pipe,
    });
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

      <div className="demo-note">
        <b>Remediation runbook layer (Unit 7) live.</b> Click a red or amber pipe verdict for the
        mapped operator tool. Triggers are operator-only and stubbed (no live call); observability
        stays read-only against the middleware and NAV.
      </div>

      <div className="wrap">
        {error && (
          <div className="sec">
            <span className="aux">Backend unreachable: {error}. Start the backend on :8080.</span>
          </div>
        )}

        {/* Leadership rollup: the top-of-page glance layer (Unit 6). */}
        <LeadershipStrip rollup={rollup} asOf={rollupAsOf} />

        <PipelineStrip pipelines={pipelines} onRemediate={openPipeRemediation} />

        <div className="sec">
          <h2>Inventory sync</h2>
          <div className="rule" />
          <span className="aux">reference monitor: freshness · liveness · push-outcome</span>
        </div>
        <InventoryPanel pipe={inventoryPipe} />

        <div className="sec">
          <h2>Back-sync</h2>
          <div className="rule" />
          <span className="aux">NAV shipment to Shopify: freshness · liveness · missed shipments</span>
        </div>
        <BackSyncPanel pipe={backSyncPipe} />

        <div className="sec">
          <h2>Price sync</h2>
          <div className="rule" />
          <span className="aux">Unit 3 monitor: received freshness · syncer liveness</span>
        </div>
        <PriceSyncPanel pipe={priceSyncPipe} />

        <div className="sec">
          <h2>NAV job queue</h2>
          <div className="rule" />
          <span className="aux">Unit 3 monitor: verdict consumed from middleware, not recomputed</span>
        </div>
        <JobQueuePanel pipe={jobQueuePipe} />

        <div className="sec">
          <h2>Shopify webhooks</h2>
          <div className="rule" />
          <span className="aux">Unit 3 monitor: last received per topic · subscription health</span>
        </div>
        <ShopifyWebhookPanel pipe={webhookPipe} />

        <div className="sec">
          <h2>Warehouse split</h2>
          <div className="rule" />
          <span className="aux">allocator: decision freshness · liveness · split-sanity</span>
        </div>
        <AllocatorPanel pipe={allocatorPipe} />

        <div className="sec">
          <h2>Order health</h2>
          <div className="rule" />
          <span className="aux">
            per-order lifecycle across both channels; wholesale has no Shopify leg
          </span>
        </div>
        <div className="controls">
          <ChannelFilter value={channel} onChange={setChannel} />
          <StageFilter value={stage} onChange={setStage} />
          <OrderSearch value={orderSearch} onChange={setOrderSearch} />
          <RowCountControl value={rowCount} onChange={setRowCount} />
          <span className="count">
            showing {shownOrders.length} of {orders.length} orders
          </span>
        </div>
        <OrderTable orders={shownOrders} />
      </div>

      {/* Unit 7: error-to-remediation modal. Opens on a red/amber pipe verdict,
          names the mapped tool, and offers an operator trigger (stubbed). */}
      <RemediationModal
        subject={remediationSubject}
        registry={registry}
        onClose={() => setRemediationSubject(null)}
      />
    </>
  );
}
