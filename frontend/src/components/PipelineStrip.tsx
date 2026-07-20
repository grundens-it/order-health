import type { PipelineHealth, RemediationRegistry } from '@order-health/shared';
import { VerdictChip } from './VerdictChip';

// Top layer: one card per pipe with its freshness/liveness verdict. UX review
// (Session B): the ENTIRE card is the click + keyboard target, not just the pill,
// and EVERY card is openable, including green ones (a green card opens to WHY
// (healthy) + DIAGNOSE so an operator can still inspect and dry-run). Each card
// carries a small mode hint (fix / diagnose / instruct) so the operator knows the
// resolution shape before clicking, and the verdict is encoded by word + shape +
// color (never color alone) via the shared VerdictChip.
const PIPE_LABELS: Record<string, string> = {
  inventory_sync: 'Inventory sync',
  back_sync: 'Back-sync (NAV to Shopify)',
  price_sync: 'Price sync',
  nav_job_queue: 'NAV job queue',
  shopify_webhook: 'Shopify webhooks',
  allocator: 'Allocator split',
  oos_held: 'OOS-held backlog',
  fs_location_divergence: 'FS-location divergence',
};

// The three resolution modes, matching the modal's RESOLVE region. Derived from the
// pipe's PRIMARY mapped tool: a callable middleware endpoint is a one-click FIX; a
// read-only ops tool (triage / reconcile / chase) is DIAGNOSE; a write-capable ops
// runbook (a NAV-admin / IT action) is INSTRUCT. Falls back to diagnose when no
// tool is mapped or the registry has not loaded.
type Mode = 'fix' | 'diagnose' | 'instruct';

function modeForPipe(pipeKey: string, registry: RemediationRegistry | null): Mode {
  if (registry === null) return 'diagnose';
  const mapping = registry.mappings.find((m) => m.subjectKey === pipeKey && m.primary);
  if (mapping === undefined) return 'diagnose';
  const tool = registry.tools.find((t) => t.id === mapping.toolId);
  if (tool === undefined) return 'diagnose';
  if (tool.kind === 'middleware_endpoint') return 'fix';
  return tool.writeCapable ? 'instruct' : 'diagnose';
}

const MODE_LABEL: Record<Mode, string> = {
  fix: 'One-click fix',
  diagnose: 'Diagnose',
  instruct: 'Guided steps',
};

// Small mode-hint icons (wrench / stethoscope / clipboard), inline so there is no
// icon dependency. aria-hidden: the adjacent text label carries the meaning.
function ModeIcon({ mode }: { mode: Mode }): JSX.Element {
  const common = { width: 13, height: 13, viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false } as const;
  if (mode === 'fix') {
    // wrench
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8 6.2 21l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.4 2.4-2.3-.6-.6-2.3 2.3-2.5z" />
      </svg>
    );
  }
  if (mode === 'instruct') {
    // clipboard
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="8" y="3" width="8" height="4" rx="1" />
        <path d="M8 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2" />
      </svg>
    );
  }
  // stethoscope (diagnose)
  return (
    <svg {...common} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3v5a5 5 0 0 0 10 0V3" />
      <circle cx="18" cy="15" r="2.5" />
      <path d="M11 13v1a5 5 0 0 0 5 5" />
    </svg>
  );
}

export function PipelineStrip({
  pipelines,
  registry,
  onRemediate,
}: {
  pipelines: PipelineHealth[];
  registry: RemediationRegistry | null;
  onRemediate: (pipe: PipelineHealth) => void;
}): JSX.Element {
  return (
    <>
      <div className="sec">
        <h2>Pipeline health</h2>
        <div className="rule" />
        <span className="aux">click any card to inspect, diagnose, and resolve</span>
      </div>
      <div className="pipes">
        {pipelines.map((p) => {
          const label = PIPE_LABELS[p.pipe] ?? p.pipe;
          const mode = modeForPipe(p.pipe, registry);
          const activate = (): void => onRemediate(p);
          return (
            <div
              className={`pipe clickable mode-${mode}`}
              key={p.pipe}
              role="button"
              tabIndex={0}
              aria-label={`Open ${label}: inspect and resolve`}
              onClick={activate}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  activate();
                }
              }}
            >
              <div className="hd">
                <span className="nm">{label}</span>
                <VerdictChip verdict={p.pipe_verdict} />
              </div>
              <div className="pipe-foot">
                <span className={`mode-hint mode-${mode}`}>
                  <ModeIcon mode={mode} />
                  {MODE_LABEL[mode]}
                </span>
                <span className="pipe-open">Open</span>
              </div>
            </div>
          );
        })}
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
