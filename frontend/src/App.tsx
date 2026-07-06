import { useEffect, useMemo, useState } from 'react';
import type {
  ChannelFilter as ChannelFilterValue,
  OrderHealth,
  PipelineHealth,
} from '@order-health/shared';
import { fetchOrders, fetchPipelines } from './api';
import { PipelineStrip } from './components/PipelineStrip';
import { InventoryPanel } from './components/InventoryPanel';
import { BackSyncPanel } from './components/BackSyncPanel';
import { OrderTable } from './components/OrderTable';
import { ChannelFilter } from './components/ChannelFilter';

// The single route: the two-layer shell (pipeline strip on top, order table
// below) with a DTC / wholesale / all channel filter and the snapshot as_of.
export function App(): JSX.Element {
  const [channel, setChannel] = useState<ChannelFilterValue>('all');
  const [pipelines, setPipelines] = useState<PipelineHealth[]>([]);
  const [orders, setOrders] = useState<OrderHealth[]>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchPipelines(), fetchOrders(channel)])
      .then(([pipeRes, orderRes]) => {
        if (cancelled) return;
        setPipelines(pipeRes.data);
        setOrders(orderRes.data);
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
        <b>Inventory Sync Monitor (Unit 1) live.</b> Other pipeline cards and order rows are
        placeholders populated by later Phase W units. Read-only service: no changes to the
        middleware or NAV.
      </div>

      <div className="wrap">
        {error && (
          <div className="sec">
            <span className="aux">Backend unreachable: {error}. Start the backend on :8080.</span>
          </div>
        )}

        <PipelineStrip pipelines={pipelines} />

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
          <h2>Order health</h2>
          <div className="rule" />
          <span className="aux">populated by Phase W units</span>
        </div>
        <div className="controls">
          <ChannelFilter value={channel} onChange={setChannel} />
          <span className="count">{orders.length} orders</span>
        </div>
        <OrderTable orders={orders} />
      </div>
    </>
  );
}
