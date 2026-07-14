// Remediation client (Unit 7, design.md 5A.4; executable Tier 1, ADR-0010).
//
// BOUNDARY (read carefully): this is the ONLY place remediation is invoked, and it
// invokes ONLY on an EXPLICIT operator action routed through api/remediation.ts.
// It NEVER fires automatically and is NEVER imported by the aggregator. It calls
// the middleware's EXISTING authenticated endpoints (or names a documented ops
// runbook); it adds NO new middleware endpoint and makes NAV nothing but read-only.
//
// DISARMED BY DEFAULT (ADR-0010). A live authenticated POST is issued ONLY when
// ALL of these hold:
//   * config.remediation.liveEnabled is true (armed) AND config.remediation.killSwitch is false,
//   * the operator confirmed the action (options.confirmed === true),
//   * the tool is a middleware_endpoint tool (ops_runbook tools NEVER mutate), and
//   * the endpoint is not heldFromLivePath (destructive-no-rollback actions stay disarmed).
// Otherwise every trigger returns a typed 'would_trigger' result with the exact
// call and makes NO live HTTP request - byte-for-byte the prior stub behaviour.
//
// AUDIT: every operator execution (armed or disarmed) appends one append-only
// RemediationAuditEntry. The NAV toggle password and the bearer token are NEVER
// recorded. The aggregator path never reaches here, so the log stays empty unless
// an operator acted (the no-auto-trigger invariant, asserted in the tests).
import type {
  RemediationAuditEntry,
  RemediationTool,
  RemediationTriggerResult,
} from '@order-health/shared';
import { config } from '../config';
import { buildUrl } from '../sources/middlewareClient';

// A single operator action's arming/confirmation intent, passed from the route.
export interface TriggerOptions {
  confirmed: boolean; // the per-action operator sign-off (ADR-0010)
}

// Per-request timeout for the live POST. A stalled middleware must fail fast into
// the typed error path, never block the route.
export const REMEDIATION_TIMEOUT_MS = 8000;

// Append-only audit log of operator executions (accountability artifact + test
// hook). Never touched by the aggregator; grows only on the explicit operator path.
const auditLog: RemediationAuditEntry[] = [];

// Test/inspection hook: the recorded operator executions so far.
export function getRemediationAuditLog(): readonly RemediationAuditEntry[] {
  return auditLog;
}
export function __resetRemediationAuditLogForTest(): void {
  auditLog.length = 0;
}

// The documented authenticated call shape a tool WOULD issue, or its ops step.
function wouldCallDescription(tool: RemediationTool): string {
  if (tool.kind === 'middleware_endpoint' && tool.endpoint) {
    const gated = tool.endpoint.gated ? ' + NAV_TOGGLE_PASSWORD' : '';
    return `${tool.endpoint.method} ${tool.endpoint.path} (Authorization: Bearer <middleware token>${gated}) -> ${tool.endpoint.source}`;
  }
  if (tool.runbook) {
    const diag = tool.runbook.diagnostic ? `diagnose: ${tool.runbook.diagnostic}; ` : '';
    return `${diag}ops runbook ${tool.runbook.ref}${tool.runbook.command ? `: ${tool.runbook.command}` : ''}`;
  }
  return 'no call shape available';
}

// Whether an armed, confirmed operator action on this tool may fire a live POST.
// ops_runbook tools never mutate; held-out endpoints (destructive, no rollback)
// stay disarmed regardless of the arm state.
function isLiveExecutable(tool: RemediationTool): boolean {
  return (
    tool.kind === 'middleware_endpoint' &&
    tool.endpoint !== undefined &&
    tool.endpoint.heldFromLivePath !== true
  );
}

// The NON-SECRET call parameters recorded in the audit log and echoed to the
// operator. The password and the bearer token are deliberately excluded.
function auditParams(tool: RemediationTool, confirmed: boolean): Record<string, unknown> {
  if (tool.kind === 'middleware_endpoint' && tool.endpoint) {
    return {
      method: tool.endpoint.method,
      path: tool.endpoint.path,
      gated: tool.endpoint.gated === true,
      held: tool.endpoint.heldFromLivePath === true,
      confirmed,
    };
  }
  return { kind: tool.kind, runbook: tool.runbook?.ref ?? null, confirmed };
}

// The live authenticated POST to the middleware's EXISTING endpoint. Sends
// Authorization: Bearer <MIDDLEWARE_AUTH_TOKEN>; a gated endpoint adds the NAV
// toggle password (and set_by) to the JSON body. Returns the response status; any
// network/timeout/parse failure throws to the typed error path in the caller.
async function firePost(
  tool: RemediationTool,
  resolvedSubject: RemediationTriggerResult['resolvedSubject'],
): Promise<number> {
  const endpoint = tool.endpoint;
  if (endpoint === undefined) throw new Error('no endpoint to fire');

  // Minimal, honest body: the health subject being remediated plus set_by; gated
  // endpoints add the NAV write-gate password. The exact per-endpoint body shape
  // beyond this is a middleware contract to confirm before arming (see PR notes).
  const body: Record<string, unknown> = {
    set_by: 'order-health-operator',
    subjectKind: resolvedSubject?.subjectKind ?? null,
    subjectKey: resolvedSubject?.subjectKey ?? null,
  };
  if (endpoint.gated === true) {
    body.password = config.remediation.togglePassword;
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    Accept: 'application/json',
  };
  if (config.middleware.authToken.length > 0) {
    headers.Authorization = `Bearer ${config.middleware.authToken}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMEDIATION_TIMEOUT_MS);
  try {
    const res = await fetch(buildUrl(config.middleware.baseUrl, endpoint.path), {
      method: endpoint.method,
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`${endpoint.method} ${endpoint.path} -> HTTP ${res.status}`);
    }
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}

// Trigger a remediation ON EXPLICIT OPERATOR ACTION. Disarmed by default: returns a
// typed 'would_trigger' result and makes NO live call unless the path is armed, not
// kill-switched, confirmed, and the tool is live-executable. Records exactly one
// append-only audit entry per call, whatever the outcome. Never throws to the route.
export async function triggerRemediation(
  tool: RemediationTool,
  resolvedSubject: RemediationTriggerResult['resolvedSubject'],
  nowIso: string,
  options: TriggerOptions = { confirmed: false },
): Promise<RemediationTriggerResult> {
  const armed = config.remediation.liveEnabled && !config.remediation.killSwitch;
  const fireLive = armed && options.confirmed && isLiveExecutable(tool);

  const base = {
    as_of: nowIso,
    toolId: tool.id,
    toolName: tool.name,
    kind: tool.kind,
    wouldCall: wouldCallDescription(tool),
    resolvedSubject,
  };

  const record = (outcome: RemediationTriggerResult['status']): void => {
    auditLog.push({
      at: nowIso,
      toolId: tool.id,
      subjectKind: resolvedSubject?.subjectKind ?? null,
      subjectKey: resolvedSubject?.subjectKey ?? null,
      params: auditParams(tool, options.confirmed),
      outcome,
    });
  };

  if (!fireLive) {
    // DISARMED / unconfirmed / kill-switched / ops_runbook / held-out: no live call.
    // eslint-disable-next-line no-console
    console.info(
      `[remediation] operator triggered "${tool.id}"; WOULD run: ${base.wouldCall} (no live call - ${armed ? (options.confirmed ? 'not live-executable' : 'unconfirmed') : 'disarmed'})`,
    );
    record('would_trigger');
    return {
      ...base,
      status: 'would_trigger',
      message: `Would trigger "${tool.name}" (operator-confirmed). No live call is made (${armed ? 'held/unconfirmed' : 'remediation disarmed'}).`,
      live: false,
    };
  }

  // ARMED + confirmed + live-executable: fire the authenticated middleware POST.
  try {
    const httpStatus = await firePost(tool, resolvedSubject);
    // eslint-disable-next-line no-console
    console.info(`[remediation] operator FIRED "${tool.id}" live -> HTTP ${httpStatus}`);
    record('triggered');
    return {
      ...base,
      status: 'triggered',
      message: `Triggered "${tool.name}" against the middleware (HTTP ${httpStatus}).`,
      live: true,
      httpStatus,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[remediation] live trigger of "${tool.id}" failed: ${reason}`);
    record('error');
    return {
      ...base,
      status: 'error',
      message: `Live trigger of "${tool.name}" failed; no change confirmed. See the error.`,
      live: true,
      error: reason,
    };
  }
}
