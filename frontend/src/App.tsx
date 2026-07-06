import { useEffect, useMemo, useState } from 'react';
import type {
  ChannelFilter as ChannelFilterValue,
  OrderHealth,
  PipelineHealth,
} from '@order-health/shared';
import { fetchOrders, fetchPipelines } from './api';
import { PipelineStrip } from './components/PipelineStrip';
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
        <b>Foundation shell.</b> Pipeline cards and order rows are placeholders populated by Phase W
        units. Read-only service: no changes to the middleware or NAV.
      </div>

      <div className="wrap">
        {error && (
          <div className="sec">
            <span className="aux">Backend unreachable: {error}. Start the backend on :8080.</span>
          </div>
        )}

        <PipelineStrip pipelines={pipelines} />

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
