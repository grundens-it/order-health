import { useState } from 'react';
import type { OrderDossier, OrderLineStatus, OrderOverallStatus } from '@order-health/shared';
import { fetchOrderDossier, ApiError } from '../api';
import { VerdictChip } from './VerdictChip';

// Order Lookup (ADR-0012). Type any order number, get everything we know about it in
// one place: NAV lines with their per-system status (ordered / shipped / invoiced /
// outstanding), the Holman EDI 940 handoff, holds, allocator trace, warehouse
// availability, and the Shopify order, composed server-side under one as_of. The order
// is resolved across the open AND posted NAV tables, so a shipped or closed order is
// still fully answerable and a base like SP-322263 fans out to its legs. Read-only;
// PII is stripped at the backend seam.

function ownerLabel(owner: string): string {
  switch (owner) {
    case 'holman': return 'Holman (3PL)';
    case 'finance': return 'Finance / AR';
    case 'customer_service': return 'Customer Service';
    case 'engineering': return 'Engineering';
    case 'grundens_ops': return 'Grundens Ops (our pipeline)';
    default: return 'No owner';
  }
}

const ORDER_STATUS_LABEL: Record<OrderOverallStatus, string> = {
  shipped: 'Shipped',
  partial: 'Partially shipped',
  in_progress: 'In progress',
  canceled: 'Canceled',
  not_found: 'Not found',
};

// Line-status pill: shape is carried by the label; colour is a secondary cue.
const LINE_STATUS_CLASS: Record<OrderLineStatus, string> = {
  shipped: 'g',
  invoiced: 'g',
  partial: 'a',
  outstanding: 'a',
  backorder: 'r',
  canceled: 'u',
  unknown: 'u',
};

function yesNo(v: boolean): string {
  return v ? 'yes' : 'no';
}

function num(n: number | null): string {
  return n === null ? '-' : String(n);
}

function DossierBody({ d }: { d: OrderDossier }): JSX.Element {
  return (
    <div className="dossier">
      {/* Overall status + the handoff verdict: where is this order, and whose is it. */}
      <div className="dsx-head">
        <span className={`dsx-status s-${d.order_status}`}>{ORDER_STATUS_LABEL[d.order_status]}</span>
        {d.handoff && <VerdictChip verdict={d.handoff.verdict} />}
        {d.handoff && <span className={`tag owner ${d.handoff.owner}`}>{d.handoff.label}</span>}
        {d.handoff && <span className="dsx-owner">Owned by {ownerLabel(d.handoff.owner)}</span>}
        {d.handoff && <p className="dsx-reason">{d.handoff.reason}</p>}
      </div>

      {/* Legs: every NAV split of the order, open or posted. */}
      {d.legs.length > 0 && (
        <div className="dsx-card">
          <h4>NAV legs ({d.legs.length})</h4>
          <table className="dsx-tbl">
            <thead><tr><th>Leg</th><th>State</th><th>NAV status</th><th>Shipped</th></tr></thead>
            <tbody>
              {d.legs.map((l) => (
                <tr key={l.order_no}>
                  <td>{l.order_no}</td>
                  <td>{l.presence === 'open' ? 'open order' : 'posted / shipped'}</td>
                  <td>{l.nav_status === null ? '-' : l.nav_status === 1 ? 'Released' : 'Open'}</td>
                  <td>{l.shipped_at ? new Date(l.shipped_at).toLocaleDateString() : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Line items with per-system status. The heart of the lookup. */}
      <div className="dsx-card">
        <h4>Line items ({d.lines.length})</h4>
        {d.lines.length > 0 ? (
          <table className="dsx-tbl">
            <thead>
              <tr><th>SKU</th><th>Description</th><th>Loc</th><th>Ord</th><th>Shp</th><th>Inv</th><th>Out</th><th>Status</th></tr>
            </thead>
            <tbody>
              {d.lines.map((l, i) => (
                <tr key={`${l.leg}-${l.sku}-${i}`}>
                  <td>{l.sku ?? '-'}</td>
                  <td>{l.description ?? '-'}</td>
                  <td>{l.location ?? '-'}</td>
                  <td>{num(l.ordered)}</td>
                  <td>{num(l.shipped)}</td>
                  <td>{num(l.invoiced)}</td>
                  <td>{num(l.outstanding)}</td>
                  <td><span className={`chip ${LINE_STATUS_CLASS[l.status]}`}><span className="ic" aria-hidden="true" />{l.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="dsx-empty">No NAV lines found for this order (open or posted).</p>
        )}
      </div>

      {/* Shopify order: fulfillment / financial / cancel status + line items. */}
      <div className="dsx-card">
        <h4>Shopify order</h4>
        {d.shopify ? (
          <>
            <dl className="dsx-kv">
              <div><dt>Total</dt><dd>{d.shopify.order_total ?? '-'} {d.shopify.currency ?? ''}</dd></div>
              <div><dt>Financial</dt><dd>{d.shopify.financial_status ?? '-'}</dd></div>
              <div><dt>Fulfillment</dt><dd>{d.shopify.fulfillment_status ?? '-'}</dd></div>
              <div><dt>Cancelled</dt><dd>{d.shopify.cancelled ? `yes (${d.shopify.cancelled_at ? new Date(d.shopify.cancelled_at).toLocaleDateString() : 'date unknown'})` : 'no'}</dd></div>
            </dl>
            {d.shopify.line_items.length > 0 && (
              <table className="dsx-tbl">
                <thead><tr><th>SKU</th><th>Qty</th><th>Name</th><th>Unit</th></tr></thead>
                <tbody>
                  {d.shopify.line_items.map((li, i) => (
                    <tr key={`${li.sku}-${i}`}><td>{li.sku || '-'}</td><td>{li.quantity}</td><td>{li.name}</td><td>{li.unit_price ?? '-'}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : (
          <p className="dsx-empty">No Shopify order fetched ({d.sources.shopify_order ?? 'not attempted'}).</p>
        )}
      </div>

      {/* Holman EDI 940 handoff. */}
      <div className="dsx-card">
        <h4>Holman EDI 940 handoff</h4>
        {d.edi ? (
          <dl className="dsx-kv">
            <div><dt>940 created</dt><dd>{yesNo(d.edi.present)}</dd></div>
            <div><dt>Sent</dt><dd>{yesNo(d.edi.sent)}</dd></div>
            <div><dt>997 acknowledged</dt><dd>{yesNo(d.edi.acked)}</dd></div>
            <div><dt>Sent date</dt><dd>{d.edi.sent_date ? new Date(d.edi.sent_date).toLocaleString() : '-'}</dd></div>
          </dl>
        ) : (
          <p className="dsx-empty">No Holman 940 exists for this order.</p>
        )}
      </div>

      {/* Warehouse availability for any outstanding SKUs. */}
      {d.availability.length > 0 && (
        <div className="dsx-card">
          <h4>Warehouse availability</h4>
          <table className="dsx-tbl">
            <thead><tr><th>SKU</th><th>Location</th><th>On hand</th><th>Available</th><th>Earliest ship</th></tr></thead>
            <tbody>
              {d.availability.map((a, i) => (
                <tr key={`${a.sku}-${a.location}-${i}`}>
                  <td>{a.sku}</td><td>{a.location}</td><td>{num(a.on_hand)}</td><td>{num(a.available)}</td>
                  <td>{a.earliest_ship_date ? new Date(a.earliest_ship_date).toLocaleDateString() : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* NAV holds. */}
      {d.holds.length > 0 && (
        <div className="dsx-card">
          <h4>NAV holds ({d.holds.length})</h4>
          <table className="dsx-tbl">
            <thead><tr><th>Reason</th><th>Owner</th><th>Date</th><th>State</th></tr></thead>
            <tbody>
              {d.holds.map((h, i) => (
                <tr key={`${h.reason_code}-${i}`}>
                  <td>{h.reason_code ?? '-'}</td><td>{ownerLabel(h.owner)}</td>
                  <td>{h.hold_date ? new Date(h.hold_date).toLocaleDateString() : '-'}</td>
                  <td>{h.released === 0 ? 'active' : 'released'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Allocator decision trace. */}
      {d.allocator.length > 0 && (
        <div className="dsx-card">
          <h4>Allocator trace ({d.allocator.length})</h4>
          <table className="dsx-tbl">
            <thead><tr><th>When</th><th>Decision</th><th>Item</th><th>Loc</th><th>Branch</th><th>Detail</th></tr></thead>
            <tbody>
              {d.allocator.map((r, i) => (
                <tr key={i}>
                  <td>{r.entry_at ? new Date(r.entry_at).toLocaleString() : '-'}</td>
                  <td>{r.decision_point ?? '-'}</td><td>{r.item_no ?? '-'}</td>
                  <td>{r.location_code ?? '-'}</td><td>{r.branch_taken ?? '-'}</td><td>{r.detail ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Source health, so a degraded read is visible, never silently empty. */}
      <div className="dsx-card">
        <h4>Sources</h4>
        <div className="dsx-sources">
          {Object.entries(d.sources).map(([k, v]) => (
            <span key={k} className={`dsx-src ${v}`}>{k}: {v}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function OrderDossierView(): JSX.Element {
  const [input, setInput] = useState('');
  const [dossier, setDossier] = useState<OrderDossier | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (): void => {
    const orderNo = input.trim();
    if (orderNo.length === 0) return;
    setLoading(true);
    setError(null);
    fetchOrderDossier(orderNo)
      .then((res) => {
        setDossier(res.dossier);
        setAsOf(res.as_of);
      })
      .catch((err: unknown) => {
        setDossier(null);
        if (err instanceof ApiError && err.status === 404) setError(`No order found for "${orderNo}".`);
        else if (err instanceof ApiError && err.kind === 'network') setError('Backend unreachable. Start the backend and try again.');
        else setError(err instanceof Error ? err.message : 'Lookup failed.');
      })
      .finally(() => setLoading(false));
  };

  return (
    <>
      <div className="sec">
        <h2>Order lookup</h2>
        <div className="rule" />
        <span className="aux">everything we know about one order, resolved across open and shipped NAV, Shopify and the middleware</span>
      </div>
      <div className="controls">
        <input
          className="searchctl"
          type="search"
          placeholder="Order number (SP-322263, a leg like SP-322263-1, or EL-...)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
          aria-label="Order number to look up"
          style={{ minWidth: 360 }}
        />
        <button type="button" className="tab on" onClick={run} disabled={loading}>
          {loading ? 'Looking up...' : 'Look up'}
        </button>
        {asOf && !loading && <span className="count">as of {new Date(asOf).toLocaleTimeString()}</span>}
      </div>

      {error && (
        <div className="sec"><span className="aux">{error}</span></div>
      )}
      {dossier && <DossierBody d={dossier} />}
    </>
  );
}
