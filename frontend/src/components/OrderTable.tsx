import type { LifecycleStage, OrderHealth } from '@order-health/shared';
import { VerdictChip } from './VerdictChip';

// Bottom layer: per-order lifecycle table (design.md 3.1 / section 6). Columns:
// order identity, channel, Shopify leg, current stage, oldest-stuck age, and the
// per-order verdict as a shape-encoded chip. Channel is first-class: wholesale
// rows render with an explicit "no Shopify leg" cell rather than as an error, and
// are never shown as orphans. Reads ONLY the snapshot rows it is handed.

// Human labels for the canonical lifecycle stages.
const STAGE_LABEL: Record<LifecycleStage, string> = {
  shopify_order: 'Shopify order',
  allocator_split: 'Allocator split',
  nav_staging: 'NAV staging',
  nav_promotion: 'NAV promotion',
  awaiting_ship: 'Awaiting ship',
  nav_shipment: 'NAV shipment',
  back_sync: 'Back-sync',
  complete: 'Complete',
};

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

export function OrderTable({ orders }: { orders: OrderHealth[] }): JSX.Element {
  return (
    <div className="tblwrap">
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Channel</th>
            <th>Shopify leg</th>
            <th>Current stage</th>
            <th>Oldest stuck</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {orders.length === 0 && (
            <tr>
              <td className="empty" colSpan={6}>
                No orders in the snapshot yet. Per-order rows are materialized by the aggregator
                once DevOps provisions the read-only NAV and middleware sources.
              </td>
            </tr>
          )}
          {orders.map((o, i) => {
            const isDtc = o.channel === 'dtc';
            const id = o.nav_order_no ?? o.shopify_order_name ?? o.customer_ref ?? `row-${i}`;
            const key = `${o.channel}:${o.nav_order_no ?? o.shopify_order_id ?? id}:${i}`;
            return (
              <tr key={key}>
                <td>
                  <div className="ord-id">{id}</div>
                  {o.customer_ref && <div className="ord-sub">{o.customer_ref}</div>}
                </td>
                <td>
                  <span className={`badge ${o.channel}`}>{isDtc ? 'DTC' : 'Wholesale'}</span>
                </td>
                <td>
                  {isDtc ? (
                    <span className="ord-id">{o.shopify_order_name ?? o.shopify_order_id ?? 'n/a'}</span>
                  ) : (
                    // Wholesale has no Shopify object: render a muted cell, never an error.
                    <span className="ord-muted">no Shopify leg</span>
                  )}
                </td>
                <td>
                  <span className="stage">{STAGE_LABEL[o.current_stage]}</span>
                  {o.is_orphan_suspect && <span className="tag orphan">orphan?</span>}
                </td>
                <td>{formatAge(o.oldest_stuck_age_s)}</td>
                <td>
                  <VerdictChip verdict={o.order_verdict} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
