import type { AllocatorDetail, PipelineHealth, Verdict } from '@order-health/shared';
import { VerdictChip } from './VerdictChip';

// The Allocator (Warehouse Split) expanded panel (Unit 4, design.md 3.2 / 5,
// matching the demo's "Warehouse split" tab):
//   - three verdict cards (decision freshness, allocator liveness, split-sanity),
//   - the recent split-decisions table (Mari's 4 rules, warehouse_allocation_log).
// It reads ONLY the snapshot row it is handed (the pipe's PipelineHealth). No
// live fan-out to the middleware; freshness is self-disclosing via the row and
// the page as_of. Copied from InventoryPanel.tsx.

// Cast the loose wire detail to the typed allocator shape.
function readDetail(p: PipelineHealth): AllocatorDetail | null {
  const d = p.detail as Partial<AllocatorDetail>;
  if (!d || d.sanity === undefined) return null;
  return d as AllocatorDetail;
}

function humanAge(seconds: number | null): string {
  if (seconds === null) return 'no data';
  if (seconds < 90) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function pct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return '-';
  return `${(rate * 100).toFixed(1)}%`;
}

// green/amber/red result chip for a single decision outcome.
const OUTCOME_VERDICT: Record<string, Verdict> = {
  allocated: 'green',
  split: 'green',
  unallocatable: 'red',
  failed: 'red',
};

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

export function AllocatorPanel({ pipe }: { pipe: PipelineHealth | null }): JSX.Element {
  if (pipe === null) {
    return (
      <div className="ip-empty">
        No allocator snapshot yet. The aggregator writes this row on the order-layer cadence from the
        middleware allocation log (read-only and DevOps-gated).
      </div>
    );
  }

  const detail = readDetail(pipe);
  const sanity = detail?.sanity ?? null;
  const decisions = detail?.recent_decisions ?? [];

  const sanityVerdict: Verdict = sanity?.sanity_verdict ?? 'unknown';
  const decisionsWindow = sanity?.decisions_window ?? null;
  const splitRate = sanity?.split_rate;
  const failedRate = sanity?.failed_rate;
  const unallocatable = sanity?.unallocatable_count ?? null;
  const failed = sanity?.failed_count ?? null;
  const atpFallbacks = sanity?.atp_fallback_count ?? null;

  return (
    <div className="ip">
      {/* Three verdict cards: freshness, liveness, split-sanity (design.md 3.2). */}
      <div className="ip-cards">
        <VerdictCard
          title="Decision freshness"
          verdict={pipe.freshness_verdict}
          metric={`last decision ${humanAge(pipe.watermark_lag_s)}`}
          sub={
            decisionsWindow === null
              ? 'recency of the newest split decision'
              : `${decisionsWindow.toLocaleString()} decisions in window · split rate ${pct(splitRate)}`
          }
        />
        <VerdictCard
          title="Allocator liveness"
          verdict={pipe.liveness_verdict}
          metric={`heartbeat ${humanAge(pipe.heartbeat_age_s)}`}
          sub="allocator loop heartbeat · independent of freshness"
        />
        <VerdictCard
          title="Split-sanity (un-allocatable / failed)"
          verdict={sanityVerdict}
          metric={failedRate === null || failedRate === undefined ? 'no data' : pct(failedRate)}
          sub={
            unallocatable === null && failed === null
              ? 'share of decisions with no ATP or an error'
              : `unallocatable ${unallocatable ?? '-'} · failed ${failed ?? '-'} · ATP fallbacks ${
                  atpFallbacks ?? '-'
                }`
          }
        />
      </div>

      {/* Split-sanity explainer: this signal, unlike inventory divergence, can go red. */}
      {sanityVerdict === 'red' && (
        <div className="ip-note a">
          Un-allocatable / failed splits exceed the red threshold. The allocator is returning no ATP
          (or erroring) for a real share of lines, which holds those orders before NAV staging. This
          is surfaced RED because it is a true allocation failure, not a counting artifact.
        </div>
      )}

      {/* Recent split decisions table (Mari's 4 rules, warehouse_allocation_log). */}
      <div className="ip-panel">
        <h3>Recent split decisions</h3>
        {decisions.length === 0 ? (
          <div className="ip-sub">No allocation decisions in the snapshot yet.</div>
        ) : (
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Channel</th>
                  <th>Line (SKU)</th>
                  <th>Qty</th>
                  <th>Rule applied</th>
                  <th>Location</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((d, i) => (
                  <tr key={`${d.order_ref ?? 'row'}-${i}`}>
                    <td className="mono">{d.order_ref ?? '-'}</td>
                    <td>{d.channel ?? '-'}</td>
                    <td>{d.sku ?? '-'}</td>
                    <td className="mono">{d.qty ?? '-'}</td>
                    <td>{d.rule ?? '-'}</td>
                    <td className="mono">{d.location ?? '-'}</td>
                    <td>
                      <VerdictChip verdict={OUTCOME_VERDICT[d.outcome] ?? 'unknown'} />
                    </td>
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
