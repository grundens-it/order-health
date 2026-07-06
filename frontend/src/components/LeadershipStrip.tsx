import type { LeadershipRollup } from '@order-health/shared';
import { VerdictChip } from './VerdictChip';

// The leadership rollup strip (design.md section 6, Unit 6): the top-of-page
// glance layer. It renders the headline verdict (shape-encoded chip), the oldest
// stuck age, the inventory-sync-fresh indicator, and at-a-glance counts. It reads
// ONLY the rollup the backend derived from the latest snapshot (no live fan-out),
// and it always shows the snapshot as_of. Operator detail lives below the fold.

const HEADLINE_LABEL: Record<LeadershipRollup['headline'], string> = {
  healthy: 'Orders healthy',
  at_risk: 'Orders at risk',
  stuck: 'Orders stuck',
};

// Human age, matching the InventoryPanel treatment (seconds -> s / m / h).
function humanAge(seconds: number | null): string {
  if (seconds === null) return 'none';
  if (seconds < 90) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function freshLabel(fresh: boolean | null): { text: string; cls: string } {
  if (fresh === null) return { text: 'unknown', cls: 'u' };
  return fresh ? { text: 'fresh', cls: 'g' } : { text: 'stale', cls: 'r' };
}

export function LeadershipStrip({
  rollup,
  asOf,
}: {
  rollup: LeadershipRollup | null;
  asOf: string | null;
}): JSX.Element {
  const asOfLabel = asOf ? `as of ${new Date(asOf).toLocaleString()}` : 'no snapshot yet';

  if (rollup === null) {
    return (
      <div className="lead lead-empty">
        <div className="lead-hd">
          <h2>Leadership rollup</h2>
          <span className="lead-asof">{asOfLabel}</span>
        </div>
        <div className="lead-note">
          No snapshot yet. The rollup is derived read-only from the latest pipeline and order
          snapshot (no new source).
        </div>
      </div>
    );
  }

  const fresh = freshLabel(rollup.inventory_sync_fresh);
  const c = rollup.counts;

  return (
    <div className="lead">
      <div className="lead-hd">
        <h2>Leadership rollup</h2>
        <span className="lead-asof">
          Snapshot <b>{asOfLabel}</b>
        </span>
      </div>
      <div className="lead-tiles">
        {/* Headline verdict, shape-encoded via the shared VerdictChip. */}
        <div className="lead-tile">
          <span className="lead-k">Headline</span>
          <div className="lead-v">
            <VerdictChip verdict={rollup.headline_verdict} />
          </div>
          <span className="lead-sub">{HEADLINE_LABEL[rollup.headline]}</span>
        </div>

        {/* Oldest stuck (red) order age. */}
        <div className="lead-tile">
          <span className="lead-k">Oldest stuck order</span>
          <div className={`lead-v lead-metric ${rollup.oldest_stuck_age_s !== null ? 'lead-warn' : ''}`}>
            {humanAge(rollup.oldest_stuck_age_s)}
          </div>
          <span className="lead-sub">age of the oldest red order</span>
        </div>

        {/* Inventory-sync fresh yes / no / unknown. */}
        <div className="lead-tile">
          <span className="lead-k">Inventory sync</span>
          <div className="lead-v">
            <span className={`lead-pill ${fresh.cls}`}>
              <span className="lead-dot" aria-hidden="true" />
              {fresh.text}
            </span>
          </div>
          <span className="lead-sub">watermark freshness</span>
        </div>

        {/* At-a-glance order counts by verdict. */}
        <div className="lead-tile">
          <span className="lead-k">Orders</span>
          <div className="lead-v lead-counts">
            <span className="lead-c r">{c.orders_red} stuck</span>
            <span className="lead-c a">{c.orders_amber} at risk</span>
            <span className="lead-c g">{c.orders_green} healthy</span>
          </div>
          <span className="lead-sub">{c.orders_total} orders in snapshot</span>
        </div>

        {/* At-a-glance pipe counts by verdict. */}
        <div className="lead-tile">
          <span className="lead-k">Pipes</span>
          <div className="lead-v lead-counts">
            <span className="lead-c r">{c.pipes_red} red</span>
            <span className="lead-c a">{c.pipes_amber} amber</span>
            <span className="lead-c g">{c.pipes_green} green</span>
          </div>
          <span className="lead-sub">{c.pipes_total} pipes monitored</span>
        </div>
      </div>
    </div>
  );
}
