import type { PipelineHealth } from '@order-health/shared';
import { VerdictChip } from './VerdictChip';

// Top layer: one card per pipe with its freshness/liveness verdict. Cards are
// placeholders in the shell; Phase W units (Unit 1 = inventory_sync first) fill
// in the real metrics behind each pipe key.
const PIPE_LABELS: Record<string, string> = {
  inventory_sync: 'Inventory sync',
  back_sync: 'Back-sync (NAV to Shopify)',
  price_sync: 'Price sync',
  nav_job_queue: 'NAV job queue',
  shopify_webhook: 'Shopify webhooks',
  allocator: 'Allocator split',
};

export function PipelineStrip({ pipelines }: { pipelines: PipelineHealth[] }): JSX.Element {
  return (
    <>
      <div className="sec">
        <h2>Pipeline health</h2>
        <div className="rule" />
        <span className="aux">populated by Phase W units</span>
      </div>
      <div className="pipes">
        {pipelines.map((p) => (
          <div className="pipe" key={p.pipe}>
            <div className="hd">
              <span className="nm">{PIPE_LABELS[p.pipe] ?? p.pipe}</span>
              <VerdictChip verdict={p.pipe_verdict} />
            </div>
            <div className="placeholder">
              Freshness and liveness metrics render here once this pipe&apos;s Phase W unit lands.
            </div>
          </div>
        ))}
        {pipelines.length === 0 && (
          <div className="pipe">
            <div className="hd">
              <span className="nm">No snapshot yet</span>
              <VerdictChip verdict="unknown" />
            </div>
            <div className="placeholder">
              The aggregator has not written a pipeline snapshot (sources are DevOps-gated).
            </div>
          </div>
        )}
      </div>
    </>
  );
}
