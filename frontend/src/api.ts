// Typed fetch helpers for the backend read API. The shared package supplies the
// response types, so the frontend and backend agree on the as_of envelope.
import type {
  AuthMeResponse,
  ChannelFilter,
  OrdersResponse,
  PipelinesResponse,
  RemediationArmStateResponse,
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

// The resolved principal (issue #96): the SPA reads this to decide whether to show
// the Admin-only arm/disarm panel. The server is still the real gate on every write.
export function fetchAuthMe(): Promise<AuthMeResponse> {
  return getJson<AuthMeResponse>('/api/auth/me');
}

// Admin arm/disarm panel (issue #97). GET the current arm state + kill switch,
// PUT to set each. Admin-only on the server; a non-Admin PUT returns 403.
export function fetchArmState(): Promise<RemediationArmStateResponse> {
  return getJson<RemediationArmStateResponse>('/api/admin/arm-state');
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`request to ${url} responded ${res.status}`);
  }
  return (await res.json()) as T;
}

export function putArmState(armed: boolean): Promise<RemediationArmStateResponse> {
  return putJson<RemediationArmStateResponse>('/api/admin/arm-state', { armed });
}

export function putKillSwitch(killed: boolean): Promise<RemediationArmStateResponse> {
  return putJson<RemediationArmStateResponse>('/api/admin/kill-switch', { killed });
}

// Operator trigger. Fires ONLY on an explicit operator action in the modal. The
// backend is DISARMED by default (ADR-0010): with confirmed:true it fires the
// middleware's EXISTING authenticated endpoint when the path is armed, otherwise it
// returns a typed 'would_trigger' preview and makes no live call. `confirmed` is the
// per-action operator sign-off; the modal only sets it on the explicit second-step
// "Confirm and run" click.
export async function triggerRemediation(
  toolId: string,
  subject: { subjectKind: 'pipe' | 'signal' | 'order'; subjectKey: string } | null,
  confirmed: boolean,
): Promise<RemediationTriggerResult> {
  const res = await fetch(`/api/remediation/${encodeURIComponent(toolId)}/trigger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(subject ?? {}), confirmed }),
  });
  if (!res.ok) {
    throw new Error(`remediation trigger responded ${res.status}`);
  }
  return (await res.json()) as RemediationTriggerResult;
}
