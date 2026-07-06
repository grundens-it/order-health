import type { JobQueueDetail, PipelineHealth } from '@order-health/shared';
import { VerdictChip } from './VerdictChip';

// NAV Job Queue Monitor panel (Unit 3, design.md 6). This pipe CONSUMES the
// middleware's already-computed verdict and surfaces it unchanged; it does NOT
// recompute health from the numbers below. The numbers are context only.
// Reads ONLY the snapshot row it is handed.

function readDetail(p: PipelineHealth): JobQueueDetail | null {
  const d = p.detail as Partial<JobQueueDetail>;
  if (!d || d.source !== 'middleware:job-queue/health') return null;
  return d as JobQueueDetail;
}

function humanAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'no data';
  if (seconds < 90) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function JobQueuePanel({ pipe }: { pipe: PipelineHealth | null }): JSX.Element {
  if (pipe === null) {
    return (
      <div className="ip-empty">
        No job-queue snapshot yet. This pipe adopts the middleware&apos;s job-queue/health verdict
        (sources are read-only and DevOps-gated).
      </div>
    );
  }
  const detail = readDetail(pipe);
  return (
    <div className="ip">
      <div className="ip-cards ip-cards-2">
        <div className="ip-card">
          <div className="ip-card-hd">
            <h3>Queue health (consumed)</h3>
            <VerdictChip verdict={pipe.pipe_verdict} />
          </div>
          <div className="ip-metric">
            {detail?.stuck_job_count === null || detail?.stuck_job_count === undefined
              ? '-'
              : `${detail.stuck_job_count} stuck`}
          </div>
          <div className="ip-sub">
            longest running {humanAge(detail?.longest_running_job_s)} · CU 50009 auto-release{' '}
            {humanAge(detail?.auto_release_age_s)} ago
          </div>
        </div>
        <div className="ip-card">
          <div className="ip-card-hd">
            <h3>Source verdict</h3>
            <VerdictChip verdict={pipe.pipe_verdict} />
          </div>
          <div className="ip-metric mono-sm">{detail?.middleware_verdict_raw ?? 'unknown'}</div>
          <div className="ip-sub">
            adopted from middleware job-queue/health, not recomputed · checked{' '}
            {detail?.checked_at ?? '-'}
          </div>
        </div>
      </div>
      <div className="ip-note">
        This verdict is surfaced from the middleware&apos;s existing job-queue/health endpoint. The
        Order Health service does not re-derive job-queue health (design.md section 6); the numbers
        above are shown for context only.
      </div>
    </div>
  );
}
