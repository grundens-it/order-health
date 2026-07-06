import { useState } from 'react';
import type { Channel, LifecycleStage, OrderHealth, Verdict } from '@order-health/shared';
import { VerdictChip } from './VerdictChip';
import { humanAge } from '../format';
import type { RemediationSubject } from './RemediationModal';

// Bottom layer: the per-order lifecycle table with a stage-dot row per hop, ported
// from the demo. Columns: ORDER (+ customer), CHANNEL pill, six hop dots, AGE,
// VERDICT pill. Rows expand to a per-hop timeline, an explanation line, and inline
// actions.
//
// STAGE-DOT DERIVATION (the API returns current_stage + order_verdict + channel,
// NOT per-hop states, so we derive each dot):
//   The six display hops, in order, are: Shopify, Split, Staging, Promote, Ship,
//   Back-sync. We map the order's current_stage to an index in that display chain
//   (awaiting_ship and nav_shipment both collapse to the single "Ship" hop;
//   'complete' means every hop is done).
//   - Wholesale is NAV-originated with no Shopify leg, so its Shopify, Split, and
//     Back-sync hops render as the dotted "no leg" marker (never an error).
//   - Any real hop BEFORE the current index is done -> green.
//   - The current hop is amber when the order is in flight within SLO (order
//     verdict green/amber) and red when it is errored or past SLO (order verdict
//     red); an unreported (unknown) current hop renders hollow "pending".
//   - Any real hop AFTER the current index is not started -> hollow "pending".
//   This reproduces the demo dot rows from live snapshot fields alone.

type Dot = 'g' | 'a' | 'r' | 'pending' | 'na';

// The six display hops (label + which lifecycle stage they represent).
const DISPLAY_HOPS: { key: string; label: string; done: string; wait: string; err: string }[] = [
  { key: 'shopify_order', label: 'Shopify', done: 'Order received', wait: 'Receiving', err: 'Order intake errored' },
  { key: 'allocator_split', label: 'Split', done: 'Split decided', wait: 'Deciding split', err: 'Split errored' },
  { key: 'nav_staging', label: 'Staging', done: 'Written to staging', wait: 'Writing to staging', err: 'Staging promotion errored' },
  { key: 'nav_promotion', label: 'Promote', done: 'Promoted to Sales Header', wait: 'Awaiting promotion', err: 'Promotion errored' },
  { key: 'ship', label: 'Ship', done: 'Shipment posted', wait: 'Awaiting ship', err: 'Ship overdue' },
  { key: 'back_sync', label: 'Back-sync', done: 'fulfillmentCreate sent', wait: 'Awaiting back-sync', err: 'Back-sync missing' },
];

// current_stage -> index in the display chain above.
function currentIndex(stage: LifecycleStage): number {
  switch (stage) {
    case 'shopify_order':
      return 0;
    case 'allocator_split':
      return 1;
    case 'nav_staging':
      return 2;
    case 'nav_promotion':
      return 3;
    case 'awaiting_ship':
    case 'nav_shipment':
      return 4;
    case 'back_sync':
      return 5;
    case 'complete':
    default:
      return DISPLAY_HOPS.length; // all hops done
  }
}

// Wholesale has no Shopify / Split / Back-sync leg (design.md 4).
const WHOLESALE_NO_LEG = new Set(['shopify_order', 'allocator_split', 'back_sync']);

function dotForHop(hopIndex: number, curIdx: number, channel: Channel, verdict: Verdict, hopKey: string): Dot {
  if (channel === 'wholesale' && WHOLESALE_NO_LEG.has(hopKey)) return 'na';
  if (hopIndex < curIdx) return 'g'; // completed prefix
  if (hopIndex > curIdx) return 'pending'; // not started yet
  // The current, in-flight hop: red when errored/past SLO, else amber (in flight
  // within SLO), hollow when the source has not reported (unknown).
  if (verdict === 'red') return 'r';
  if (verdict === 'unknown') return 'pending';
  return 'a';
}

function dotsFor(o: OrderHealth): Dot[] {
  const curIdx = currentIndex(o.current_stage);
  return DISPLAY_HOPS.map((h, i) => dotForHop(i, curIdx, o.channel, o.order_verdict, h.key));
}

// Per-hop description shown in the expanded timeline.
function hopDesc(dot: Dot, hop: (typeof DISPLAY_HOPS)[number]): string {
  if (dot === 'na') return 'No leg for this channel';
  if (dot === 'pending') return 'Not started';
  if (dot === 'g') return hop.done;
  if (dot === 'r') return hop.err;
  return hop.wait;
}

const AGE_CLASS: Record<Verdict, string> = {
  green: '',
  amber: 'warnv',
  red: 'redv',
  unknown: '',
};

// The order-level remediation signal for a red order, derived from its stage.
function signalFor(o: OrderHealth): RemediationSubject {
  if (o.current_stage === 'nav_staging') {
    return { subjectKind: 'signal', subjectKey: 'nav_staging_stuck', label: `Stuck NAV staging - ${orderId(o)}` };
  }
  // Missed back-sync is the generic recovery-sweep case (matches the demo button).
  return { subjectKind: 'signal', subjectKey: 'missed_back_sync', label: `Recovery sweep - ${orderId(o)}` };
}

function orderId(o: OrderHealth): string {
  return o.shopify_order_name ?? o.nav_order_no ?? o.customer_ref ?? 'order';
}

function OrderRow({
  o,
  onRemediate,
  onInert,
}: {
  o: OrderHealth;
  onRemediate: (s: RemediationSubject) => void;
  onInert: (label: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const dots = dotsFor(o);
  const isRed = o.order_verdict === 'red';
  const id = orderId(o);

  return (
    <>
      <tr
        className="row"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <td className="oid">
          {id}
          {o.customer_ref && <small>{o.customer_ref}</small>}
        </td>
        <td>
          <span className={`badge ${o.channel}`}>{o.channel === 'dtc' ? 'DTC' : 'Wholesale'}</span>
        </td>
        {dots.map((d, i) => (
          <td className="stagecell" key={DISPLAY_HOPS[i]!.key}>
            <span className={`dot ${d}`} title={`${DISPLAY_HOPS[i]!.label}: ${hopDesc(d, DISPLAY_HOPS[i]!)}`} />
          </td>
        ))}
        <td className={`agecell ${AGE_CLASS[o.order_verdict]}`}>{humanAge(o.oldest_stuck_age_s)}</td>
        <td>
          <VerdictChip verdict={o.order_verdict} />
        </td>
      </tr>
      {open && (
        <tr className="detail">
          <td colSpan={10}>
            <div className="din">
              <div className="timeline">
                {DISPLAY_HOPS.map((hop, i) => (
                  <div className={`step ${dots[i]}`} key={hop.key}>
                    <div className="bar" />
                    <div className="st">{hop.label}</div>
                    <div className="sd">{hopDesc(dots[i]!, hop)}</div>
                  </div>
                ))}
              </div>
              {o.note && <div className={`note ${o.order_verdict === 'red' ? 'r' : o.order_verdict === 'amber' ? 'a' : ''}`}>{o.note}</div>}
              <div className="actions">
                <button
                  className="minibtn"
                  title="configure middleware deep-link"
                  onClick={(e) => {
                    e.stopPropagation();
                    onInert('Open in NAV SQL console');
                  }}
                >
                  Open in NAV SQL console
                </button>
                <button
                  className="minibtn"
                  title="configure middleware deep-link"
                  onClick={(e) => {
                    e.stopPropagation();
                    onInert('View allocation log');
                  }}
                >
                  View allocation log
                </button>
                {isRed && (
                  <button
                    className="minibtn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemediate(signalFor(o));
                    }}
                  >
                    Trigger recovery sweep
                  </button>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function OrderTable({
  orders,
  onRemediate,
  onInert,
}: {
  orders: OrderHealth[];
  onRemediate: (s: RemediationSubject) => void;
  onInert: (label: string) => void;
}): JSX.Element {
  return (
    <div className="tblwrap">
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Channel</th>
            {DISPLAY_HOPS.map((h) => (
              <th className="stage" key={h.key}>
                {h.label}
              </th>
            ))}
            <th>Age</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {orders.length === 0 && (
            <tr>
              <td className="empty" colSpan={10}>
                No orders in the snapshot yet. Per-order rows are materialized by the aggregator
                once DevOps provisions the read-only NAV and middleware sources.
              </td>
            </tr>
          )}
          {orders.map((o, i) => (
            <OrderRow
              key={`${o.channel}:${o.nav_order_no ?? o.shopify_order_id ?? orderId(o)}:${i}`}
              o={o}
              onRemediate={onRemediate}
              onInert={onInert}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
