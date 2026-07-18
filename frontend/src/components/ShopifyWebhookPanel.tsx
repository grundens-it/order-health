import type { PipelineHealth, ShopifyWebhookDetail } from '@order-health/shared';
import { VerdictChip } from './VerdictChip';

// Shopify Webhook Monitor panel (Unit 3, design.md 5): per-topic last-received
// plus the subscription-removal signal (a removed/absent subscription is
// amber-or-worse, the WAF-removal failure mode). Reads ONLY the snapshot row.

function readDetail(p: PipelineHealth): ShopifyWebhookDetail | null {
  const d = p.detail as Partial<ShopifyWebhookDetail>;
  if (!d || d.topics === undefined) return null;
  return d as ShopifyWebhookDetail;
}

function humanAge(seconds: number | null): string {
  if (seconds === null) return 'no data';
  if (seconds < 90) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function ShopifyWebhookPanel({ pipe }: { pipe: PipelineHealth | null }): JSX.Element {
  if (pipe === null) {
    return (
      <div className="ip-empty">
        No webhook snapshot yet. The aggregator writes last-received per topic and each topic&apos;s
        subscription state (sources are read-only and DevOps-gated).
      </div>
    );
  }
  const detail = readDetail(pipe);
  const topics = detail?.topics ?? [];
  const missing = detail?.missing_subscription_count ?? 0;
  return (
    <div className="ip">
      <div className="ip-cards ip-cards-2">
        <div className="ip-card">
          <div className="ip-card-hd">
            <h3>Intake freshness</h3>
            <VerdictChip verdict={pipe.freshness_verdict} />
          </div>
          <div className="ip-metric">{topics.length}</div>
          <div className="ip-sub">topics tracked · worst per-topic last-received freshness</div>
        </div>
        <div className="ip-card">
          <div className="ip-card-hd">
            <h3>Subscriptions</h3>
            <VerdictChip verdict={pipe.liveness_verdict} />
          </div>
          <div className="ip-metric">{missing}</div>
          <div className="ip-sub">
            removed / absent subscriptions (amber-or-worse: the WAF-removal failure mode)
          </div>
        </div>
      </div>

      {missing > 0 && (
        <div className="ip-note a">
          {missing} expected webhook {missing === 1 ? 'subscription is' : 'subscriptions are'} removed
          or absent. A removed subscription is surfaced amber-or-worse: it is the 19-consecutive-4xx
          WAF-removal failure mode from the integration map.
        </div>
      )}

      <div className="ip-panel">
        <h3>Last received per topic</h3>
        {topics.length === 0 ? (
          <div className="ip-sub">No topics in the snapshot yet.</div>
        ) : (
          <div className="tblwrap" style={{ marginTop: 6 }}>
            <table>
              <thead>
                <tr>
                  <th>Topic</th>
                  <th>Last received</th>
                  <th>Subscription</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {topics.map((t) => (
                  <tr key={t.topic}>
                    <td className="mono">{t.topic}</td>
                    <td className="mono">{humanAge(t.last_received_age_s)}</td>
                    <td className={`mono ${t.subscribed ? '' : 'ip-warn'}`}>
                      {t.subscribed ? 'active' : 'removed'}
                    </td>
                    <td>
                      <VerdictChip verdict={t.verdict} />
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
