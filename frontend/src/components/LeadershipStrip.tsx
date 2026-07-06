import type { LeadershipRollup } from '@order-health/shared';
import { humanAge } from '../format';

// Leadership rollup (design.md section 6, Unit 6): the top-of-page glance layer,
// ported to the demo's five KPI cards with colored left rails. Every value is read
// from /api/health/rollup (counts, oldest_stuck_age_s, inventory_sync_fresh,
// headline). Nothing is fabricated; a null inventory-fresh renders "pending".

type Rail = 'g' | 'a' | 'r';

interface Kpi {
  cls: Rail;
  lab: string;
  val: string;
  sub: string;
}

function buildKpis(r: LeadershipRollup): Kpi[] {
  const c = r.counts;
  const stuck = c.orders_red;
  const risk = c.orders_amber;
  const healthy = c.orders_green;

  // Oldest-stuck rail follows the headline: red while any order is stuck, amber
  // while any is at risk, else green.
  const oldestRail: Rail = stuck > 0 ? 'r' : risk > 0 ? 'a' : 'g';

  // inventory_sync_fresh is a tri-state: true (fresh/green), false (stale/red),
  // null (unknown, no inventory_sync freshness reported yet).
  const fresh = r.inventory_sync_fresh;
  const invRail: Rail = fresh === true ? 'g' : fresh === false ? 'r' : 'a';
  const invVal = fresh === true ? 'Fresh' : fresh === false ? 'STALE' : 'pending';
  const invSub =
    fresh === true
      ? 'watermark within cycle'
      : fresh === false
        ? 'watcher behind, needs attention'
        : 'no freshness signal yet';

  return [
    {
      cls: stuck > 0 ? 'r' : 'g',
      lab: 'Orders stuck',
      val: String(stuck),
      sub: stuck > 0 ? 'need operator action' : 'none right now',
    },
    {
      cls: risk > 0 ? 'a' : 'g',
      lab: 'At risk',
      val: String(risk),
      sub: 'in flight, watching SLO',
    },
    { cls: 'g', lab: 'Healthy', val: String(healthy), sub: 'flowing normally' },
    {
      cls: oldestRail,
      lab: 'Oldest stuck age',
      val: humanAge(r.oldest_stuck_age_s),
      sub: r.oldest_stuck_age_s !== null ? 'time at current hop' : 'nothing stuck',
    },
    { cls: invRail, lab: 'Inventory sync fresh', val: invVal, sub: invSub },
  ];
}

export function LeadershipStrip({
  rollup,
}: {
  rollup: LeadershipRollup | null;
}): JSX.Element {
  if (rollup === null) {
    return (
      <div className="rollup">
        <div className="kpi">
          <span className="edge" />
          <div className="lab">Leadership rollup</div>
          <div className="val">--</div>
          <div className="sub">no snapshot yet</div>
        </div>
      </div>
    );
  }

  const kpis = buildKpis(rollup);
  return (
    <div className="rollup">
      {kpis.map((k) => (
        <div className={`kpi ${k.cls}`} key={k.lab}>
          <span className="edge" />
          <div className="lab">{k.lab}</div>
          <div className="val">{k.val}</div>
          <div className="sub">{k.sub}</div>
        </div>
      ))}
    </div>
  );
}
