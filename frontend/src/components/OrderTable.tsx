import type { OrderHealth } from '@order-health/shared';
import { VerdictChip } from './VerdictChip';

// Bottom layer: per-order lifecycle table. The shell renders the frame, channel
// badge, and worst-stage verdict; Phase W units add the per-stage columns and
// drill-in. Empty in the scaffold because the order source reads are stubbed.
export function OrderTable({ orders }: { orders: OrderHealth[] }): JSX.Element {
  return (
    <div className="tblwrap">
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Channel</th>
            <th>Stage</th>
            <th>Oldest stuck</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {orders.length === 0 && (
            <tr>
              <td className="empty" colSpan={5}>
                No orders in the snapshot yet. Per-order rows and stage columns are populated by
                Phase W units; source reads are DevOps-gated.
              </td>
            </tr>
          )}
          {orders.map((o, i) => {
            const id = o.shopify_order_name ?? o.nav_order_no ?? o.customer_ref ?? `row-${i}`;
            const age = o.oldest_stuck_age_s === null ? '-' : `${o.oldest_stuck_age_s}s`;
            return (
              <tr key={id}>
                <td>{id}</td>
                <td>
                  <span className={`badge ${o.channel}`}>
                    {o.channel === 'dtc' ? 'DTC' : 'Wholesale'}
                  </span>
                </td>
                <td>{o.current_stage}</td>
                <td>{age}</td>
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
