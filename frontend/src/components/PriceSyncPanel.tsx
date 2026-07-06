import type { PipelineHealth, PriceSyncDetail } from '@order-health/shared';
import { VerdictChip } from './VerdictChip';

// Price Sync Monitor panel (Unit 3, design.md 3): two verdict cards, freshness
// (last price-sync received) and liveness (last price-sync run). Reads ONLY the
// snapshot row it is handed; no live fan-out. Freshness is self-disclosing via
// the row and the page as_of.

function readDetail(p: PipelineHealth): PriceSyncDetail | null {
  const d = p.detail as Partial<PriceSyncDetail>;
  if (!d || d.last_received_age_s === undefined) return null;
  return d as PriceSyncDetail;
}

function humanAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'no data';
  if (seconds < 90) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function PriceSyncPanel({ pipe }: { pipe: PipelineHealth | null }): JSX.Element {
  if (pipe === null) {
    return (
      <div className="ip-empty">
        No price-sync snapshot yet. The aggregator writes this row on the pipeline cadence (sources
        are read-only and DevOps-gated).
      </div>
    );
  }
  const detail = readDetail(pipe);
  return (
    <div className="ip">
      <div className="ip-cards ip-cards-2">
        <div className="ip-card">
          <div className="ip-card-hd">
            <h3>Received freshness</h3>
            <VerdictChip verdict={pipe.freshness_verdict} />
          </div>
          <div className="ip-metric">{humanAge(pipe.watermark_lag_s)}</div>
          <div className="ip-sub">since last price-sync signal received</div>
        </div>
        <div className="ip-card">
          <div className="ip-card-hd">
            <h3>Syncer liveness</h3>
            <VerdictChip verdict={pipe.liveness_verdict} />
          </div>
          <div className="ip-metric">{humanAge(pipe.heartbeat_age_s)}</div>
          <div className="ip-sub">
            since last price-sync run{detail ? ` · run at ${detail.last_run_at ?? '-'}` : ''}
          </div>
        </div>
      </div>
    </div>
  );
}
