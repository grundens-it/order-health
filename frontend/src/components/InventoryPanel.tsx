import type { InventorySyncDetail, PipelineHealth, Verdict } from '@order-health/shared';
import { VerdictChip } from './VerdictChip';

// The inventory-sync expanded panel (design.md 5A.2, matching the demo):
//   - three verdict cards (freshness, liveness, push-outcome / divergence),
//   - the recent-walks bar chart (pushed per cycle),
//   - the walks table.
// It reads ONLY the snapshot row it is handed (the pipe's PipelineHealth). No
// live fan-out to NAV; freshness is self-disclosing via the row and the page
// as_of. This is the reference panel Units 2 to 6 copy.

// Cast the loose wire detail to the typed inventory-sync shape.
function readDetail(p: PipelineHealth): InventorySyncDetail | null {
  const d = p.detail as Partial<InventorySyncDetail>;
  if (!d || d.divergence === undefined) return null;
  return d as InventorySyncDetail;
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

export function InventoryPanel({ pipe }: { pipe: PipelineHealth | null }): JSX.Element {
  if (pipe === null) {
    return (
      <div className="ip-empty">
        No inventory-sync snapshot yet. The aggregator writes this row on the ~2h inventory cadence
        (sources are read-only and DevOps-gated).
      </div>
    );
  }

  const detail = readDetail(pipe);
  const divergence = detail?.divergence ?? null;
  const walks = detail?.recent_walks ?? [];
  const maxPushed = walks.reduce((m, w) => Math.max(m, w.pushed), 0);

  const divRatio = divergence?.ratio;
  const divVerdict: Verdict = divergence?.divergence_verdict ?? 'unknown';
  const wouldPush = divergence?.dryrun_would_push ?? null;
  const totalPairs = divergence?.total_pairs ?? null;
  const liveTrailing = divergence?.live_push_trailing ?? null;

  return (
    <div className="ip">
      {/* Three verdict cards: freshness, liveness, push-outcome (design.md 5A.1). */}
      <div className="ip-cards">
        <VerdictCard
          title="Watermark freshness"
          verdict={pipe.freshness_verdict}
          metric={`lag ${humanAge(pipe.watermark_lag_s)}`}
          sub={
            detail
              ? `watermark entry ${detail.watermark_entry_no ?? '-'} · newest IABC ${
                  detail.nav_newest_iabc_entry_no ?? '-'
                }${detail.watermark_entry_gap ? ` (gap ${detail.watermark_entry_gap})` : ''}`
              : 'newest IABC entry vs watermark'
          }
        />
        <VerdictCard
          title="Watcher liveness"
          verdict={pipe.liveness_verdict}
          metric={`heartbeat ${humanAge(pipe.heartbeat_age_s)}`}
          sub={`trigger ${detail?.trigger_mode ?? 'job_queue'} · independent of freshness`}
        />
        <VerdictCard
          title="Push-outcome (dry-run divergence)"
          verdict={divVerdict}
          metric={
            wouldPush === null
              ? 'no dry-run'
              : `${wouldPush.toLocaleString()}${totalPairs ? ` / ${totalPairs.toLocaleString()}` : ''}`
          }
          sub={
            wouldPush === null
              ? 'last dry-run would-push vs trailing live push'
              : `live push trailing ${liveTrailing ?? '-'} · ratio ${
                  divRatio === null || divRatio === undefined ? '-' : divRatio.toFixed(1)
                }x`
          }
        />
      </div>

      {/* The amber-never-red explainer (design.md 5A.3, the 7,245 question). */}
      {divVerdict === 'amber' && wouldPush !== null && (
        <div className="ip-note a">
          Dry-run would-push ({wouldPush.toLocaleString()}) far exceeds recent live-walk volume. This
          is surfaced AMBER and never auto-red: it is likely a counting artifact (re-activations the
          dry-run counts but a live walk does not), not a true backlog, and stays amber until the
          reconciliation open question is resolved.
        </div>
      )}

      {/* Recent catalog walks: bar chart (pushed per cycle) + table. */}
      <div className="ip-panel">
        <h3>Recent catalog walks (pushed per cycle)</h3>
        {walks.length === 0 ? (
          <div className="ip-sub">No walks in the snapshot yet.</div>
        ) : (
          <>
            <div className="ip-bars">
              {walks
                .slice()
                .reverse()
                .map((w, i) => (
                  <div
                    key={w.walk_at ?? i}
                    className={`ip-bar ${w.pushed === maxPushed && maxPushed > 0 ? 'hl' : ''}`}
                    style={{ height: `${Math.max(8, maxPushed > 0 ? (w.pushed / maxPushed) * 100 : 8)}%` }}
                    title={`${w.walk_at ?? ''}: pushed ${w.pushed}`}
                  >
                    <span>{w.walk_at ? new Date(w.walk_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-'}</span>
                  </div>
                ))}
            </div>
            <div className="tblwrap" style={{ marginTop: 22 }}>
              <table>
                <thead>
                  <tr>
                    <th>Walk</th>
                    <th>Processed</th>
                    <th>Pushed</th>
                    <th>Skipped</th>
                    <th>Untracked filtered</th>
                  </tr>
                </thead>
                <tbody>
                  {walks.map((w, i) => (
                    <tr key={w.walk_at ?? i}>
                      <td className="mono">
                        {w.walk_at ? new Date(w.walk_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-'}
                      </td>
                      <td className="mono">{w.processed.toLocaleString()}</td>
                      <td className="mono">{w.pushed.toLocaleString()}</td>
                      <td className="mono">{w.skipped.toLocaleString()}</td>
                      <td className={`mono ${w.untracked_filtered > 0 ? 'ip-warn' : ''}`}>
                        {w.untracked_filtered}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
