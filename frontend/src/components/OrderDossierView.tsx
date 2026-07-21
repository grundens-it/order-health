import { useState } from 'react';
import type { OrderDossier } from '@order-health/shared';
import { fetchOrderDossier, ApiError } from '../api';
import { VerdictChip } from './VerdictChip';

// Order Lookup (ADR-0012). Type any order number, get everything we know about it in
// one place: NAV header + lines, the Holman EDI 940 handoff, holds, allocator trace,
// warehouse availability, and the Shopify order, all composed server-side under one
// as_of and stamped with the same handoff verdict the board uses. Read-only. The
// backend strips PII at the seam, so there is no customer identity to render here.

function ownerLabel(owner: string): string {
  switch (owner) {
    case 'holman':
      return 'Holman (3PL)';
    case 'finance':
      return 'Finance / AR';
    case 'customer_service':
      return 'Customer Service';
    case 'engineering':
      return 'Engineering';
    case 'grundens_ops':
      return 'Grundens Ops (our pipeline)';
    default:
      return 'No owner';
  }
}

function yesNo(v: boolean): string {
  return v ? 'yes' : 'no';
}

function DossierBody({ d }: { d: OrderDossier }): JSX.Element {
  return (
    <div className="dossier">
      {/* Verdict header: whose order this is, and why. */}
      {d.handoff && (
        <div className="dsx-head">
          <VerdictChip verdict={d.handoff.verdict} />
          <span className={`tag owner ${d.handoff.owner}`}>{d.handoff.label}</span>
          <span className="dsx-owner">Owned by {ownerLabel(d.handoff.owner)}</span>
          <p className="dsx-reason">{d.handoff.reason}</p>
        </div>
      )}

      {/* Identity. No customer name / address / email by design. */}
      <div className="dsx-card">
        <h4>Order</h4>
        {d.identity ? (
          <dl className="dsx-kv">
            <div><dt>NAV order</dt><dd>{d.identity.nav_order_no ?? '-'}</dd></div>
            <div><dt>Channel</dt><dd>{d.identity.channel ?? '-'}</dd></div>
            <div><dt>Shopify order</dt><dd>{d.identity.shopify_order_name ?? '-'}</dd></div>
            <div><dt>Ordered</dt><dd>{d.identity.order_at ? new Date(d.identity.order_at).toLocaleString() : '-'}</dd></div>
            <div><dt>Released</dt><dd>{d.identity.released === null ? '-' : yesNo(d.identity.released)}</dd></div>
            <div><dt>Preseason</dt><dd>{d.identity.preseason === null ? '-' : yesNo(d.identity.preseason)}</dd></div>
          </dl>
        ) : (
          <p className="dsx-empty">Not in the open-orders board (closed, fully shipped, or unknown order number). The per-source reads below still ran.</p>
        )}
      </div>

      {/* EDI handoff: the definitive Holman check. */}
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

      {/* Outstanding lines. */}
      <div className="dsx-card">
        <h4>Outstanding lines ({d.lines.length})</h4>
        {d.lines.length > 0 ? (
          <table className="dsx-tbl">
            <thead><tr><th>SKU</th><th>Location</th><th>Outstanding</th></tr></thead>
            <tbody>
              {d.lines.map((l, i) => (
                <tr key={`${l.sku}-${i}`}><td>{l.sku ?? '-'}</td><td>{l.location ?? '-'}</td><td>{l.outstanding ?? '-'}</td></tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="dsx-empty">No outstanding lines.</p>
        )}
      </div>

      {/* Warehouse availability across HF1FTZ + TAC. */}
      <div className="dsx-card">
        <h4>Warehouse availability</h4>
        {d.availability.length > 0 ? (
          <table className="dsx-tbl">
            <thead><tr><th>SKU</th><th>Location</th><th>On hand</th><th>Available</th><th>Earliest ship</th></tr></thead>
            <tbody>
              {d.availability.map((a, i) => (
                <tr key={`${a.sku}-${a.location}-${i}`}>
                  <td>{a.sku}</td><td>{a.location}</td><td>{a.on_hand ?? '-'}</td><td>{a.available ?? '-'}</td>
                  <td>{a.earliest_ship_date ? new Date(a.earliest_ship_date).toLocaleDateString() : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="dsx-empty">No availability rows at HF1FTZ or TAC.</p>
        )}
      </div>

      {/* NAV holds, with the owning team derived from the reason code. */}
      <div className="dsx-card">
        <h4>NAV holds ({d.holds.length})</h4>
        {d.holds.length > 0 ? (
          <table className="dsx-tbl">
            <thead><tr><th>Reason</th><th>Owner</th><th>Date</th><th>Released</th></tr></thead>
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
        ) : (
          <p className="dsx-empty">No holds on this order.</p>
        )}
      </div>

      {/* Allocator decision trace. Never contains customer PII. */}
      <div className="dsx-card">
        <h4>Allocator trace ({d.allocator.length})</h4>
        {d.allocator.length > 0 ? (
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
        ) : (
          <p className="dsx-empty">No allocator decisions logged.</p>
        )}
      </div>

      {/* Shopify order: line items + money only, no customer block. */}
      <div className="dsx-card">
        <h4>Shopify order</h4>
        {d.shopify ? (
          <>
            <dl className="dsx-kv">
              <div><dt>Total</dt><dd>{d.shopify.order_total ?? '-'} {d.shopify.currency ?? ''}</dd></div>
              <div><dt>Financial</dt><dd>{d.shopify.financial_status ?? '-'}</dd></div>
              <div><dt>Fulfillment</dt><dd>{d.shopify.fulfillment_status ?? '-'}</dd></div>
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
        if (err instanceof ApiError && err.status === 404) {
          setError(`No order found for "${orderNo}".`);
        } else if (err instanceof ApiError && err.kind === 'network') {
          setError('Backend unreachable. Start the backend and try again.');
        } else {
          setError(err instanceof Error ? err.message : 'Lookup failed.');
        }
      })
      .finally(() => setLoading(false));
  };

  return (
    <>
      <div className="sec">
        <h2>Order lookup</h2>
        <div className="rule" />
        <span className="aux">everything we know about one order, from NAV, Shopify and the middleware</span>
      </div>
      <div className="controls">
        <input
          className="searchctl"
          type="search"
          placeholder="Order number (e.g. SP-322263-1 or EL-...)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') run();
          }}
          aria-label="Order number to look up"
          style={{ minWidth: 320 }}
        />
        <button type="button" className="tab on" onClick={run} disabled={loading}>
          {loading ? 'Looking up...' : 'Look up'}
        </button>
        {asOf && !loading && <span className="count">as of {new Date(asOf).toLocaleTimeString()}</span>}
      </div>

      {error && (
        <div className="sec">
          <span className="aux">{error}</span>
        </div>
      )}
      {dossier && <DossierBody d={dossier} />}
    </>
  );
}
