import type {
  ForwardSyncDetail,
  ForwardSyncTag,
  PipelineHealth,
  Verdict,
} from '@order-health/shared';
import { VerdictChip } from './VerdictChip';
import type { RemediationSubject } from './RemediationModal';

// Forward-sync deep-dive panel (Unit 11, ADR-0006 phase 1). Reads ONLY the handed
// forward_sync pipeline_health_snapshot row: no live fan-out. Two verdict cards
// (backlog, export liveness), a headline line, a stalled-window note, a coverage
// label so a green is not over-read, and an oldest-first backlog sample table.
// A blind source renders the Unknown chip, never a false green. Reuses the shared
// VerdictChip (shape-encoded, not color alone) and the existing .ip-* classes.

// Local compact age helper (panel-scoped). null => "no data"; under 90s => seconds;
// under 90m => minutes; else hours and minutes. No em dashes in produced copy.
function humanAge(seconds: number | null): string {
  if (seconds === null || Number.isNaN(seconds)) return 'no data';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Defensive cast of the loose detail Record to the typed ForwardSyncDetail. Returns
// null when the shape is absent (source not yet provisioned), so nothing reads green
// off a missing bag.
function forwardSyncDetail(pipe: PipelineHealth): ForwardSyncDetail | null {
  const d = pipe.detail as unknown as ForwardSyncDetail | null | undefined;
  if (!d || typeof d !== 'object') return null;
  if (typeof d.backlog_count !== 'number') return null;
  return d;
}

const TAG_LABEL: Record<ForwardSyncTag, string> = {
  shopify_exported: 'Exported',
  middleware_status: 'Middleware',
  unknown: 'Unknown',
};

// Honest coverage label so "no staging-stalled backlog" is not over-read as
// "no never-staged losses" (ADR-0006 consequences).
function coverageLabel(detail: ForwardSyncDetail): string {
  if (detail.coverage === 'staging') {
    return 'coverage: staging (never-staged tail pending phase 2)';
  }
  return 'coverage: staging+tags';
}

// One verdict card. Actionable (role button, keyboard, pointer, Resolve affordance)
// exactly when its verdict is red or amber AND onRemediate is provided.
function VerdictCard({
  title,
  verdict,
  metric,
  sub,
  onRemediate,
}: {
  title: string;
  verdict: Verdict;
  metric: string;
  sub: string;
  onRemediate?: (subject: RemediationSubject) => void;
}): JSX.Element {
  const actionable = (verdict === 'red' || verdict === 'amber') && onRemediate !== undefined;
  const activate = (): void => {
    onRemediate?.({ subjectKind: 'pipe', subjectKey: 'forward_sync', label: title });
  };
  const interaction = actionable
    ? {
        role: 'button',
        tabIndex: 0,
        onClick: activate,
        onKeyDown: (e: React.KeyboardEvent): void => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
          }
        },
        'aria-label': `${title}: open remediation`,
      }
    : {};
  return (
    <div className={`ip-card${actionable ? ' fs-actionable' : ''}`} {...interaction}>
      <div className="ip-card-hd">
        <h3>{title}</h3>
        <VerdictChip verdict={verdict} />
      </div>
      <div className="ip-metric mono-sm">{metric}</div>
      <div className="ip-sub">{sub}</div>
      {actionable && <div className="fs-resolve">Resolve &rarr;</div>}
    </div>
  );
}

export function ForwardSyncPanel({
  pipe,
  onRemediate,
}: {
  pipe: PipelineHealth | null;
  onRemediate?: (subject: RemediationSubject) => void;
}): JSX.Element {
  if (pipe === null) {
    return (
      <>
        <div className="sec">
          <h2>Forward sync</h2>
          <div className="rule" />
        </div>
        <div className="ip-empty">
          No forward-sync snapshot yet. The aggregator writes this row on the order cadence
          (sources are read-only and DevOps-gated).
        </div>
      </>
    );
  }

  const detail = forwardSyncDetail(pipe);
  const bothUnknown =
    pipe.freshness_verdict === 'unknown' && pipe.liveness_verdict === 'unknown';
  const unsourced = detail === null || bothUnknown;

  const backlogCount = detail?.backlog_count ?? 0;
  const lastImport = humanAge(pipe.heartbeat_age_s);

  // Headline line below the cards, by state.
  let headline: string;
  if (unsourced) {
    headline = 'Forward-sync source not yet provisioned (read-only, DevOps-gated)';
  } else if (backlogCount === 0) {
    headline = `No exported orders pending in NAV · last import ${lastImport}`;
  } else {
    headline = `${backlogCount} orders exported but not in NAV · oldest ${humanAge(
      pipe.watermark_lag_s,
    )} · last import ${lastImport}`;
  }

  const showStalled = detail !== null && detail.contiguous_block === true;
  const noteTone = pipe.pipe_verdict === 'red' ? 'r' : 'a';
  const sample = detail?.sample ?? [];

  return (
    <>
      <div className="sec">
        <h2>Forward sync</h2>
        <div className="rule" />
        <span className="aux">Shopify orders exported but not created in NAV</span>
      </div>

      <div className="ip-cards ip-cards-2">
        <VerdictCard
          title="Backlog (exported not in NAV)"
          verdict={pipe.freshness_verdict}
          metric={`${backlogCount} orders`}
          sub={`oldest ${humanAge(pipe.watermark_lag_s)} · newest ${humanAge(
            detail?.newest_age_s ?? null,
          )}`}
          onRemediate={onRemediate}
        />
        <VerdictCard
          title="Export liveness"
          verdict={pipe.liveness_verdict}
          metric={`last import ${lastImport}`}
          sub="time since the last Shopify to NAV order was created"
          onRemediate={onRemediate}
        />
      </div>

      <div className="fs-headline">{headline}</div>

      {showStalled && (
        <div className={`ip-note ${noteTone}`}>
          <span className="fs-note-ic" aria-hidden="true">
            &#9650;
          </span>{' '}
          Stalled window detected: {backlogCount} orders lost in one created-at window. Likely a
          systemic export stall, not scattered stragglers.
        </div>
      )}

      {detail !== null && <div className="fs-coverage">{coverageLabel(detail)}</div>}

      {sample.length > 0 && (
        <div className="tblwrap fs-table">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Age</th>
                <th>Tag</th>
              </tr>
            </thead>
            <tbody>
              {sample.map((row, i) => (
                <tr key={`${row.shopify_order_name ?? 'order'}-${i}`}>
                  <td className="mono">{row.shopify_order_name ?? 'no data'}</td>
                  <td className="mono">{humanAge(row.age_s)}</td>
                  <td>
                    <span className="fs-tag">{TAG_LABEL[row.tag]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
