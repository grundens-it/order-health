import type { LeadershipRollup, Verdict } from '@order-health/shared';

// Human age, matching the InventoryPanel treatment (seconds -> s / m / h).
function humanAge(seconds: number | null): string {
  if (seconds === null) return 'none';
  if (seconds < 90) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Leadership rollup (design.md section 6, Unit 6): the top-of-page glance layer,
// ported to the demo's five KPI cards with colored left rails. Every value is read
// from /api/health/rollup (counts, oldest_stuck_age_s, inventory_sync_fresh,
// headline). Nothing is fabricated; a null inventory-fresh renders "pending".

// Where a rollup card drills to when activated (Unit 5, #65). The parent (App)
// owns the actual navigation; the strip only names the destination. Discriminated
// on `kind` so the parent can switch exhaustively.
export type DrillTarget =
  // An order-count card (Orders stuck / At risk / Healthy): drill to the order
  // table filtered to that verdict.
  | { kind: 'orders'; verdict: Verdict }
  // The oldest-stuck-age card: drill to the offending (oldest red) order.
  | { kind: 'oldest_stuck' }
  // The inventory-sync-fresh card: drill to the inventory_sync pipe.
  | { kind: 'inventory_sync' };

type Rail = 'g' | 'a' | 'r';

interface Kpi {
  cls: Rail;
  lab: string;
  val: string;
  sub: string;
  // The drill destination for this card, and a human sentence for aria-label.
  target: DrillTarget;
  drill: string;
}

function buildKpis(r: LeadershipRollup): Kpi[] {
  const c = r.counts;
  const stuck = c.orders_red;
  const risk = c.orders_amber;
  const healthy = c.orders_green;

  // Oldest-stuck rail follows the headline: red while any order is stuck, amber
  // while any is at risk, else green.
  const oldestRail: Rail = stuck > 0 ? 'r' : risk > 0 ? 'a' : 'g';

  // Inventory freshness is now the pipe's own verdict, so the headline card shows the
  // SAME three states the pipe card does: green Fresh, amber Lagging, red Stale, and
  // unknown pending. The old boolean collapsed amber into red, so a normal mid-cycle
  // lag (the IABC populate legitimately runs every ~2 to 2.7h) lit the headline red
  // STALE while the pipe only showed At risk.
  const invFresh = r.inventory_freshness;
  const invRail: Rail = invFresh === 'green' ? 'g' : invFresh === 'red' ? 'r' : invFresh === 'amber' ? 'a' : 'a';
  const invVal =
    invFresh === 'green' ? 'Fresh' : invFresh === 'red' ? 'STALE' : invFresh === 'amber' ? 'Lagging' : 'pending';
  const invSub =
    invFresh === 'green'
      ? 'watermark within cycle'
      : invFresh === 'red'
        ? 'watcher behind, needs attention'
        : invFresh === 'amber'
          ? 'mid-cycle lag, self-clears next walk'
          : 'no freshness signal yet';

  return [
    {
      cls: stuck > 0 ? 'r' : 'g',
      lab: 'Orders stuck',
      val: String(stuck),
      sub: stuck > 0 ? 'need operator action' : 'none right now',
      target: { kind: 'orders', verdict: 'red' },
      drill: `Drill through to ${stuck} stuck (red) orders`,
    },
    {
      cls: risk > 0 ? 'a' : 'g',
      lab: 'At risk',
      val: String(risk),
      sub: 'in flight, watching SLO',
      target: { kind: 'orders', verdict: 'amber' },
      drill: `Drill through to ${risk} at-risk (amber) orders`,
    },
    {
      cls: 'g',
      lab: 'Healthy',
      val: String(healthy),
      sub: 'flowing normally',
      target: { kind: 'orders', verdict: 'green' },
      drill: `Drill through to ${healthy} healthy (green) orders`,
    },
    {
      cls: oldestRail,
      lab: 'Oldest stuck age',
      val: humanAge(r.oldest_stuck_age_s),
      sub: r.oldest_stuck_age_s !== null ? 'time at current hop' : 'nothing stuck',
      target: { kind: 'oldest_stuck' },
      drill:
        r.oldest_stuck_age_s !== null
          ? 'Drill through to the oldest stuck order'
          : 'Drill through to the oldest stuck order (none stuck right now)',
    },
    {
      cls: invRail,
      lab: 'Inventory sync fresh',
      val: invVal,
      sub: invSub,
      target: { kind: 'inventory_sync' },
      drill: 'Drill through to the inventory sync pipe',
    },
  ];
}

export function LeadershipStrip({
  rollup,
  onDrill,
}: {
  rollup: LeadershipRollup | null;
  // Optional drill-through callback (Unit 5, #65). When omitted the cards render
  // as plain, non-interactive tiles (graceful).
  onDrill?: (target: DrillTarget) => void;
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
      {kpis.map((k) => {
        const inner = (
          <>
            <span className="edge" />
            <div className="lab">{k.lab}</div>
            <div className="val">{k.val}</div>
            <div className="sub">{k.sub}</div>
          </>
        );
        // With a callback each card is a real <button>: keyboard-focusable via
        // Tab, activatable with Enter and Space (native button behaviour), and
        // labelled by where it drills. Without a callback it stays a plain tile.
        if (onDrill) {
          return (
            <button
              type="button"
              className={`kpi kpi-drill ${k.cls}`}
              key={k.lab}
              aria-label={k.drill}
              title={k.drill}
              onClick={() => onDrill(k.target)}
            >
              {inner}
            </button>
          );
        }
        return (
          <div className={`kpi ${k.cls}`} key={k.lab}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}
