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

// A typed API error distinguishing the two failure modes an operator must tell
// apart (Unit 7): a CONNECTION failure (the backend is down / unreachable) versus
// a NON-2XX response (the backend is up but errored, for example its database is
// down). The banner maps each to a different message and remedy.
export type ApiErrorKind = 'network' | 'http';
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    // fetch rejects (TypeError) only when the request never got a response: the
    // backend is down, the port is closed, DNS/network failed. That is "unreachable".
    throw new ApiError('network', `cannot reach the backend at ${url}`);
  }
  if (!res.ok) {
    // The backend answered, just not with a 2xx: it is UP but errored (a 500 from a
    // downed DB, a 4xx, etc.). This is NOT "unreachable".
    throw new ApiError('http', `backend responded ${res.status}`, res.status);
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
