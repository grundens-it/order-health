// Typed fetch helpers for the backend read API. The shared package supplies the
// response types, so the frontend and backend agree on the as_of envelope.
import type {
  ChannelFilter,
  OrdersResponse,
  PipelinesResponse,
  RemediationRegistryResponse,
  RemediationTriggerResult,
  RollupResponse,
} from '@order-health/shared';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} responded ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchPipelines(): Promise<PipelinesResponse> {
  return getJson<PipelinesResponse>('/api/health/pipelines');
}

export function fetchOrders(channel: ChannelFilter): Promise<OrdersResponse> {
  return getJson<OrdersResponse>(`/api/health/orders?channel=${channel}`);
}

export function fetchRollup(): Promise<RollupResponse> {
  return getJson<RollupResponse>('/api/health/rollup');
}

// The remediation runbook registry (read-only): the modal reads this to name the
// mapped tool for a red signal without re-declaring the runbook.
export function fetchRemediationRegistry(): Promise<RemediationRegistryResponse> {
  return getJson<RemediationRegistryResponse>('/api/remediation/registry');
}

// Operator trigger. Fires ONLY on an explicit operator action (a button press in
// the modal). The backend invokes the middleware's EXISTING endpoint via a stubbed
// client and returns a typed 'would_trigger' result; no live call is made in v1.
export async function triggerRemediation(
  toolId: string,
  subject: { subjectKind: 'pipe' | 'signal' | 'order'; subjectKey: string } | null,
): Promise<RemediationTriggerResult> {
  const res = await fetch(`/api/remediation/${encodeURIComponent(toolId)}/trigger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(subject ?? {}),
  });
  if (!res.ok) {
    throw new Error(`remediation trigger responded ${res.status}`);
  }
  return (await res.json()) as RemediationTriggerResult;
}
