import type { LifecycleStage, OrderHealth } from '@order-health/shared';
import { VerdictChip } from './VerdictChip';

// Bottom layer: per-order lifecycle table (design.md 3.1 / section 6, matching the
// demo). Each order shows a row of stage dots (Shopify · Split · Staging · Promote
// · Ship · Back-sync) so you can see exactly where it stalled: green = completed,
// amber = in flight within SLO, red = errored / past SLO, pending = not started,
// na = no leg (wholesale has no Shopify object). Channel is first-class; wholesale
// is never shown as an orphan. Reads ONLY the snapshot rows it is handed. A row is
// clickable: it opens the remediation tool mapped to the stuck stage (Unit 7).

// The six stage columns and the canonical lifecycle stage each represents.
const STAGE_COLS: ReadonlyArray<readonly [string, string]> = [
  ['Shopify', 'shopify_order'],
  ['Split', 'allocator_split'],
  ['Staging', 'nav_staging'],
  ['Promote', 'nav_promotion'],
  ['Ship', 'nav_shipment'],
  ['Back-sync', 'back_sync'],
];

// Which display column the order's current stage falls into.
function stageToCol(stage: LifecycleStage): number {
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
      return 6; // past the last column: every applicable stage is done
  }
}

// Wholesale has no Shopify leg: no Shopify order, no allocator split, no back-sync.
const WHOLESALE_NA_COLS = new Set<number>([0, 1, 5]);

type DotState = 'g' | 'a' | 'r' | 'pending' | 'na';
const DOT_TITLE: Record<DotState, string> = {
  g: 'Completed / on time',
  a: 'In flight (within SLO)',
  r: 'Errored / past SLO',
  pending: 'Not started',
  na: 'No leg (wholesale)',
};

function dotState(o: OrderHealth, col: number): DotState {
  const isDtc = o.channel === 'dtc';
  if (!isDtc && WHOLESALE_NA_COLS.has(col)) return 'na';
  const current = stageToCol(o.current_stage);
  if (col < current) return 'g'; // stage the order has moved past
  if (col === current) {
    // The stage it is sitting at: colour by the order's verdict.
    return o.order_verdict === 'red' ? 'r' : o.order_verdict === 'amber' ? 'a' : 'g';
  }
  return 'pending'; // stage not reached yet
}

// Compact age label from seconds (no em dashes, ASCII only).
function formatAge(seconds: number | null): string {
  if (seconds === null) return 'n/a';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function OrderTable({
  orders,
  onSelect,
}: {
  orders: OrderHealth[];
  onSelect?: (order: OrderHealth) => void;
}): JSX.Element {
  const colCount = 4 + STAGE_COLS.length; // Order, Channel, ...stages, Age, Verdict, action
  return (
    <>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Channel</th>
              {STAGE_COLS.map(([label]) => (
                <th key={label} className="stage">
                  {label}
                </th>
              ))}
              <th>Age</th>
              <th>Verdict</th>
              <th aria-label="Remediation" />
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 && (
              <tr>
                <td className="empty" colSpan={colCount}>
                  No orders match the current filters, or the snapshot has no order rows yet.
                </td>
              </tr>
            )}
            {orders.map((o, i) => {
              const isDtc = o.channel === 'dtc';
              const id = o.nav_order_no ?? o.shopify_order_name ?? o.customer_ref ?? `row-${i}`;
              const key = `${o.channel}:${o.nav_order_no ?? o.shopify_order_id ?? id}:${i}`;
              const actionable = o.order_verdict === 'red' || o.order_verdict === 'amber';
              const clickable = onSelect !== undefined;
              const activate = (): void => onSelect?.(o);
              return (
                <tr
                  key={key}
                  className={clickable ? 'clickable' : undefined}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  aria-label={clickable ? `Open remediation for order ${id}` : undefined}
                  onClick={clickable ? activate : undefined}
                  onKeyDown={
                    clickable
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            activate();
                          }
                        }
                      : undefined
                  }
                >
                  <td>
                    <div className="ord-id">{id}</div>
                    {o.customer_ref && <div className="ord-sub">{o.customer_ref}</div>}
                  </td>
                  <td>
                    <span className={`badge ${o.channel}`}>{isDtc ? 'DTC' : 'Wholesale'}</span>
                  </td>
                  {STAGE_COLS.map(([label], col) => {
                    const st = dotState(o, col);
                    return (
                      <td key={label} className="stagecell">
                        <span className={`dot ${st}`} title={`${label}: ${DOT_TITLE[st]}`} />
                      </td>
                    );
                  })}
                  <td>{formatAge(o.oldest_stuck_age_s)}</td>
                  <td>
                    <VerdictChip verdict={o.order_verdict} />
                    {o.is_orphan_suspect && <span className="tag orphan">orphan?</span>}
                  </td>
                  <td className="ord-action">
                    {clickable && (
                      <span className={actionable ? 'resolve' : 'resolve muted'}>
                        {actionable ? 'Resolve →' : 'View →'}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
      </div>
    </>
  );
}
