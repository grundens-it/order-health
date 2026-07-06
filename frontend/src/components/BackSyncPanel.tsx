import type { BackSyncDetail, PipelineHealth, Verdict } from '@order-health/shared';
import { VerdictChip } from './VerdictChip';

// The back-sync expanded panel (Unit 2, design.md 3.2 / 5, matching the demo):
//   - three verdict cards (freshness, liveness, missed-shipments),
//   - the missed-shipments panel (count + table from detail).
// It reads ONLY the snapshot row it is handed (the pipe's PipelineHealth). No live
// fan-out to NAV or the middleware; freshness is self-disclosing via the row and
// the page as_of. Copied from InventoryPanel.tsx.

// Cast the loose wire detail to the typed back-sync shape.
function readDetail(p: PipelineHealth): BackSyncDetail | null {
  const d = p.detail as Partial<BackSyncDetail>;
  if (!d || d.missed_verdict === undefined) return null;
  return d as BackSyncDetail;
}

function humanAge(seconds: number | null): string {
  if (seconds === null) return 'no data';
  if (seconds < 90) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function VerdictCard({
  title,
  verdict,
  metric,
  sub,
}: {
  title: string;
  verdict: Verdict;
  metric: string;
  sub: string;
}): JSX.Element {
  return (
    <div className="ip-card">
      <div className="ip-card-hd">
        <h3>{title}</h3>
        <VerdictChip verdict={verdict} />
      </div>
      <div className="ip-metric">{metric}</div>
      <div className="ip-sub">{sub}</div>
    </div>
  );
}

export function BackSyncPanel({ pipe }: { pipe: PipelineHealth | null }): JSX.Element {
  if (pipe === null) {
    return (
      <div className="ip-empty">
        No back-sync snapshot yet. The aggregator writes this row on the order cadence (sources are
        read-only and DevOps-gated).
      </div>
    );
  }

  const detail = readDetail(pipe);
  const missed = detail?.missed_shipments ?? [];
  const missedVerdict: Verdict = detail?.missed_verdict ?? 'unknown';
  const missedCount = detail?.missed_count ?? 0;
  const windowDays = detail?.missed_window_days ?? 14;
  const fulfillments = detail?.fulfillments_last_24h ?? null;
  const errors = detail?.errors_last_24h ?? null;

  return (
    <div className="ip">
      {/* Three verdict cards: freshness, liveness, missed-shipments. */}
      <div className="ip-cards">
        <VerdictCard
          title="Back-sync freshness"
          verdict={pipe.freshness_verdict}
          metric={`watermark ${humanAge(pipe.watermark_lag_s)}`}
          sub={`last fulfillmentCreate · ${fulfillments === null ? 'no data' : `${fulfillments.toLocaleString()} in 24h`}`}
        />
        <VerdictCard
          title="Watcher liveness"
          verdict={pipe.liveness_verdict}
          metric={`heartbeat ${humanAge(pipe.heartbeat_age_s)}`}
          sub="NAV shipment to Shopify · independent of freshness"
        />
        <VerdictCard
          title={`Missed shipments (${windowDays}d)`}
          verdict={missedVerdict}
          metric={missedVerdict === 'unknown' ? 'no data' : missedCount.toLocaleString()}
          sub={`NAV shipment posted, no shopify_fulfillment_id · errors 24h ${errors ?? '-'}`}
        />
      </div>

      {/* Missed-shipments explainer: this signal is a real backlog and may RED
          (the deliberate contrast with inventory-sync's amber-capped divergence). */}
      {(missedVerdict === 'amber' || missedVerdict === 'red') && missedCount > 0 && (
        <div className={`ip-note ${missedVerdict === 'red' ? 'r' : 'a'}`}>
          {missedCount.toLocaleString()} NAV shipment{missedCount === 1 ? '' : 's'} posted in the last{' '}
          {windowDays} days with no Shopify fulfillment (the fulfillmentCreate never fired). Unlike
          the dry-run divergence signal, a missed-shipments backlog is real and is allowed to reach
          RED. Wholesale shipments have no Shopify back-sync leg and are excluded.
        </div>
      )}

      {/* Missed-shipments table (count + detail rows from the snapshot). */}
      <div className="ip-panel">
        <h3>Missed shipments</h3>
        {missed.length === 0 ? (
          <div className="ip-sub">
            {missedVerdict === 'unknown'
              ? 'No back-sync snapshot data yet.'
              : 'No missed shipments in the window.'}
          </div>
        ) : (
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>WebId</th>
                  <th>NAV shipment</th>
                  <th>Carrier</th>
                  <th>Tracking</th>
                  <th>Posted</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {missed.map((s, i) => (
                  <tr key={s.nav_shipment_no ?? s.order_ref ?? i}>
                    <td className="oid">{s.order_ref ?? '-'}</td>
                    <td className="mono">{s.web_id ?? '-'}</td>
                    <td className="mono">{s.nav_shipment_no ?? '-'}</td>
                    <td>{s.carrier ?? '-'}</td>
                    <td className="mono">{s.tracking ?? '-'}</td>
                    <td className="mono">
                      {s.posted_at ? new Date(s.posted_at).toLocaleString() : '-'}
                    </td>
                    <td className="mono ip-warn">{humanAge(s.age_s)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
