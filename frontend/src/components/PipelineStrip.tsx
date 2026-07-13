import type {
  AllocatorDetail,
  BackSyncDetail,
  InventorySyncDetail,
  JobQueueDetail,
  PipelineHealth,
  PriceSyncDetail,
  ShopifyWebhookDetail,
  Verdict,
} from '@order-health/shared';
import { VerdictChip } from './VerdictChip';
import { agoLabel, clockOf, humanAge, numOr, PENDING, pctOr } from '../format';

// Top layer: six rich pipeline-health cards (3x2), ported from the demo. Each card
// reads its metric rows from that pipe's typed `detail` bag inside
// /api/health/pipelines, plus the top-level verdict columns. Values the API does
// not carry (middleware-sourced signals are stubbed until DevOps provisions them)
// render as the neutral placeholder "pending source" / "--", NEVER as a fabricated
// number or a false green. A red or amber verdict pill is a button that opens the
// mapped remediation runbook (Unit 7).

const PIPE_LABELS: Record<string, string> = {
  inventory_sync: 'Inventory sync',
  back_sync: 'Back-sync (ship to Shopify)',
  price_sync: 'Price sync',
  nav_job_queue: 'NAV job queue',
  shopify_webhook: 'Shopify webhooks',
  allocator: 'Allocator',
};

type MetricClass = '' | 'okv' | 'warnv' | 'redv';
interface Metric {
  k: string;
  v: string;
  cls?: MetricClass;
}

// A verdict-driven emphasis class for a metric value.
function vClass(v: Verdict): MetricClass {
  if (v === 'red') return 'redv';
  if (v === 'amber') return 'warnv';
  if (v === 'green') return 'okv';
  return '';
}

function freshWord(v: Verdict): string {
  if (v === 'green') return 'fresh';
  if (v === 'amber') return 'lagging';
  if (v === 'red') return 'stale';
  return 'pending source';
}

function inventoryMetrics(p: PipelineHealth): Metric[] {
  const d = p.detail as unknown as InventorySyncDetail;
  const walk = d?.last_walk ?? null;
  const div = d?.divergence ?? null;
  const wouldPush =
    div && div.dryrun_would_push !== null
      ? `${numOr(div.dryrun_would_push)} / ${numOr(div.total_pairs)}`
      : PENDING;
  return [
    {
      k: 'Watermark',
      v: d?.watermark_entry_no != null ? `entry ${numOr(d.watermark_entry_no)} - ${freshWord(p.freshness_verdict)}` : freshWord(p.freshness_verdict),
      cls: vClass(p.freshness_verdict),
    },
    {
      k: walk?.walk_at ? `Last walk ${clockOf(walk.walk_at)}` : 'Last walk',
      v: walk ? `push ${numOr(walk.pushed)} - skip ${numOr(walk.skipped)}` : PENDING,
    },
    { k: 'Untracked filtered', v: walk ? numOr(walk.untracked_filtered) : PENDING, cls: walk && walk.untracked_filtered === 0 ? 'okv' : '' },
    { k: 'Dry-run would-push', v: wouldPush, cls: div ? vClass(div.divergence_verdict) : '' },
  ];
}

function backSyncMetrics(p: PipelineHealth): Metric[] {
  const d = p.detail as unknown as BackSyncDetail;
  return [
    { k: 'Watermark age', v: humanAge(p.watermark_lag_s) },
    {
      k: `Missed shipments ${d?.missed_window_days ?? 14}d`,
      v: d ? numOr(d.missed_count) : PENDING,
      cls: d ? vClass(d.missed_verdict) : '',
    },
    { k: 'Fulfillments 24h', v: d ? numOr(d.fulfillments_last_24h) : PENDING },
    { k: 'Errors 24h', v: d ? numOr(d.errors_last_24h) : PENDING, cls: d && d.errors_last_24h === 0 ? 'okv' : d && (d.errors_last_24h ?? 0) > 0 ? 'redv' : '' },
  ];
}

function priceSyncMetrics(p: PipelineHealth): Metric[] {
  const d = p.detail as unknown as PriceSyncDetail;
  return [
    { k: 'Watermark', v: freshWord(p.freshness_verdict), cls: vClass(p.freshness_verdict) },
    { k: 'Last received', v: agoLabel(d?.last_received_at ?? null) },
    { k: 'Last run', v: agoLabel(d?.last_run_at ?? null) },
    { k: 'Liveness', v: freshWord(p.liveness_verdict), cls: vClass(p.liveness_verdict) },
  ];
}

function jobQueueMetrics(p: PipelineHealth): Metric[] {
  const d = p.detail as unknown as JobQueueDetail;
  return [
    { k: 'CU 50009 auto-release', v: agoLabel(d?.auto_release_fired_at ?? null), cls: vClass(d?.liveness_verdict ?? 'unknown') },
    { k: 'Longest in-process job', v: humanAge(d?.longest_running_job_s ?? null), cls: vClass(d?.stuck_job_verdict ?? 'unknown') },
    { k: 'Pending staging (Status 0)', v: d && d.pending_staging_count != null ? numOr(d.pending_staging_count) : PENDING, cls: vClass(d?.staging_verdict ?? 'unknown') },
    { k: 'Middleware says', v: d?.middleware_verdict_raw ?? PENDING, cls: '' },
  ];
}

function webhookMetrics(p: PipelineHealth): Metric[] {
  const d = p.detail as unknown as ShopifyWebhookDetail;
  const topics = d?.topics ?? [];
  const rows: Metric[] = topics.slice(0, 2).map((t) => ({
    k: t.topic,
    v: agoLabel(t.last_received_at),
    cls: vClass(t.verdict),
  }));
  while (rows.length < 2) rows.push({ k: 'topic', v: PENDING });
  rows.push({
    k: 'Removed subs',
    v: d ? numOr(d.missing_subscription_count) : PENDING,
    cls: d && d.missing_subscription_count === 0 ? 'okv' : d && d.missing_subscription_count > 0 ? 'redv' : '',
  });
  rows.push({ k: 'Subscriptions', v: freshWord(p.liveness_verdict), cls: vClass(p.liveness_verdict) });
  return rows;
}

function allocatorMetrics(p: PipelineHealth): Metric[] {
  const d = p.detail as unknown as AllocatorDetail;
  const s = d?.sanity ?? null;
  return [
    { k: 'Decisions in window', v: s ? numOr(s.decisions_window) : PENDING },
    { k: 'Split rate', v: s ? pctOr(s.split_rate) : PENDING },
    { k: 'Errors', v: s ? numOr(s.failed_count) : PENDING, cls: s && s.failed_count === 0 ? 'okv' : s && (s.failed_count ?? 0) > 0 ? 'redv' : '' },
    { k: 'ATP fallbacks', v: s ? numOr(s.atp_fallback_count) : PENDING },
  ];
}

const METRIC_BUILDERS: Record<string, (p: PipelineHealth) => Metric[]> = {
  inventory_sync: inventoryMetrics,
  back_sync: backSyncMetrics,
  price_sync: priceSyncMetrics,
  nav_job_queue: jobQueueMetrics,
  shopify_webhook: webhookMetrics,
  allocator: allocatorMetrics,
};

const PIPE_FOOT: Record<string, [string, string]> = {
  inventory_sync: ['trigger job_queue', 'IABC ~2h cadence'],
  back_sync: ['NAV to Shopify', 'fulfillmentCreate leg'],
  price_sync: ['trigger job_queue', 'received then run'],
  nav_job_queue: ['NAV read-only', 'computed, middleware cross-checked'],
  shopify_webhook: ['Cloudflare edge', 'subscription health'],
  allocator: ['warehouse_split', 'split-sanity signal'],
};

function metricsFor(p: PipelineHealth): Metric[] {
  const builder = METRIC_BUILDERS[p.pipe];
  if (!builder) return [{ k: 'status', v: 'pending source' }];
  return builder(p);
}

function isActionable(p: PipelineHealth): boolean {
  return p.pipe_verdict === 'red' || p.pipe_verdict === 'amber';
}

function summary(pipelines: PipelineHealth[]): string {
  const red = pipelines.filter((p) => p.pipe_verdict === 'red').length;
  const amber = pipelines.filter((p) => p.pipe_verdict === 'amber').length;
  if (red > 0) return `${red} pipe${red > 1 ? 's' : ''} unhealthy - ${amber} at risk`;
  if (amber > 0) return `${amber} at risk - rest healthy`;
  if (pipelines.length === 0) return 'no snapshot yet';
  return 'all pipes healthy';
}

export function PipelineStrip({
  pipelines,
  onRemediate,
}: {
  pipelines: PipelineHealth[];
  onRemediate: (pipe: PipelineHealth) => void;
}): JSX.Element {
  return (
    <>
      <div className="sec">
        <h2>Pipeline health</h2>
        <div className="rule" />
        <span className="aux">{summary(pipelines)} - click a red or amber verdict to remediate</span>
      </div>
      <div className="pipes">
        {pipelines.map((p) => {
          const label = PIPE_LABELS[p.pipe] ?? p.pipe;
          const foot = PIPE_FOOT[p.pipe] ?? ['', ''];
          return (
            <div className="pipe" key={p.pipe}>
              <div className="hd">
                <span className="nm">{label}</span>
                {isActionable(p) ? (
                  <button
                    className="chip-btn"
                    onClick={() => onRemediate(p)}
                    aria-label={`Open remediation for ${label}`}
                    title="Open remediation runbook"
                  >
                    <VerdictChip verdict={p.pipe_verdict} />
                  </button>
                ) : (
                  <VerdictChip verdict={p.pipe_verdict} />
                )}
              </div>
              <div className="metrics">
                {metricsFor(p).map((m, i) => (
                  <div className="m" key={`${m.k}-${i}`}>
                    <span className="k">{m.k}</span>
                    <span className={`v ${m.cls ?? ''} ${m.v === PENDING || m.v === 'pending source' ? 'pendingv' : ''}`}>
                      {m.v}
                    </span>
                  </div>
                ))}
              </div>
              <div className="foot">
                <span>{foot[0]}</span>
                <span>{foot[1]}</span>
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
            <div className="metrics">
              <div className="m">
                <span className="k">status</span>
                <span className="v pendingv">pending source</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
