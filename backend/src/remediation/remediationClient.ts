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
import { resolveRemediationFlags } from '../runtime/runtimeSettings';

// A single operator action's arming/confirmation intent, passed from the route.
export interface TriggerOptions {
  confirmed: boolean; // the per-action operator sign-off (ADR-0010)
  actor?: string;     // the authenticated principal name recorded on the audit entry (issue #96)
  // Executable remediation dry-run intent (Tier 1). Undefined or true previews with
  // no write on endpoints that support dry_run (the middleware defaults dry_run
  // true); an explicit false is the live apply. Endpoints without a dry_run flag
  // ignore this: for them any confirmed live fire is a write, gated to Admin at the
  // route. Never widens the arming gate; a live call still requires armed+confirmed.
  dryRun?: boolean;
  // The NUMERIC Shopify order id for an order-targeted endpoint (forward-sync
  // replay -> shopify_order_id; recovery replay -> shopify_order_ids:[id]). Threaded
  // from the route because the resolvedSubject.subjectKey for an ORDER is the
  // classification signal string or a split order name (SP-#####), never the numeric
  // id. Number(subjectKey) was NaN and sent 0 / [], which 502-ed the middleware.
  shopifyOrderId?: string | number;
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
function auditParams(tool: RemediationTool, confirmed: boolean, dryRun: boolean): Record<string, unknown> {
  if (tool.kind === 'middleware_endpoint' && tool.endpoint) {
    return {
      method: tool.endpoint.method,
      path: tool.endpoint.path,
      gated: tool.endpoint.gated === true,
      held: tool.endpoint.heldFromLivePath === true,
      // The effective dry_run the live body carried (true = preview, no write).
      // Only meaningful on endpoints that support it; recorded for accountability.
      dry_run: tool.endpoint.supportsDryRun === true ? dryRun : null,
      confirmed,
    };
  }
  return { kind: tool.kind, runbook: tool.runbook?.ref ?? null, confirmed };
}

// Build the EXACT per-endpoint request body for a live POST. Each middleware
// endpoint has its own confirmed contract (verified against the middleware source,
// see the PR notes), so we never send a one-size-fits-all body. Returns undefined
// for an endpoint that takes NO request body (back-sync run-now). The NAV
// write-gate password is added by firePost for gated endpoints only, never here.
export function buildRequestBody(
  tool: RemediationTool,
  resolvedSubject: RemediationTriggerResult['resolvedSubject'],
  options: TriggerOptions,
): Record<string, unknown> | undefined {
  const setBy = 'order-health-operator';
  const subjectKey = resolvedSubject?.subjectKey ?? null;
  // dry_run defaults TRUE (safe preview) unless the caller explicitly passed false.
  const dryRun = options.dryRun !== false;
  const path = tool.endpoint?.path ?? '';

  // The numeric Shopify order id for the order-targeted endpoints. Prefer the id
  // threaded end-to-end (options.shopifyOrderId); fall back only to a subjectKey
  // that is itself numeric (the OOS-held per-order path passes the id as subjectKey).
  // An order SIGNAL subjectKey ('fs_floor_at_zero') or a split name ('SP-323019') is
  // NOT numeric, so it can never masquerade as an id and send 0 / [] to the middleware.
  const rawOrderId = options.shopifyOrderId ?? subjectKey;
  const orderId = Number(rawOrderId);
  const hasOrderId = Number.isFinite(orderId) && orderId > 0;

  switch (path) {
    // recovery.rs BATCH replay (verified: ReplayRequest { shopify_order_ids: Vec<i64>,
    // password, set_by }). A list of numeric shopify_order_ids + set_by; NO dry_run
    // (idempotent, already-submitted reported). A single-order subject becomes a
    // one-element list. Empty when no numeric id resolved (the frontend disables the
    // fix; the middleware rejects [] with a clean 400 rather than 502).
    case '/api/recovery/replay-fulfillment-requests': {
      return { shopify_order_ids: hasOrderId ? [orderId] : [], set_by: setBy };
    }
    // fs-floor sweep + full sweep: dry_run (default true) + set_by. Password added
    // by firePost when gated. Async (returns 202); progress read separately.
    case '/api/nav/inventory-sync/fulfillment-service-floor':
    case '/api/nav/inventory-sync/fulfillment-service-sweep':
      return { dry_run: dryRun, set_by: setBy };
    // fs-floor one SKU: adds the SKU from the subject (the caller supplies the SKU
    // as subjectKey). dry_run (default true) + set_by; password added when gated.
    case '/api/nav/inventory-sync/fulfillment-service-floor-one':
      return { sku: subjectKey ?? '', dry_run: dryRun, set_by: setBy };
    // forward-sync replay (verified: ReplayRequest { shopify_order_id: i64 }). ONE
    // numeric shopify_order_id; un-gated, real mode, no dry_run and no set_by (the
    // middleware struct carries only this field). Uses the threaded numeric id, never
    // Number(subjectKey) (which was NaN -> 0 -> 502) for an order signal subjectKey.
    case '/api/forward-sync/replay': {
      return { shopify_order_id: hasOrderId ? orderId : 0 };
    }
    // back-sync run-now: the route takes NO json body (fires one back-sync pass).
    case '/api/back-sync/run-now':
      return undefined;
    // Any other middleware endpoint keeps the prior generic, honest body (the
    // health subject plus set_by). These endpoints' exact bodies are NOT yet
    // confirmed against the middleware source and must be verified before a live
    // fire is relied on; see the PR notes.
    default:
      return {
        set_by: setBy,
        subjectKind: resolvedSubject?.subjectKind ?? null,
        subjectKey,
      };
  }
}

// The live authenticated POST to the middleware's EXISTING endpoint. Sends
// Authorization: Bearer <MIDDLEWARE_AUTH_TOKEN>; a gated endpoint adds the NAV
// toggle password (and set_by) to the JSON body. Returns the response status; any
// network/timeout/parse failure throws to the typed error path in the caller.
async function firePost(
  tool: RemediationTool,
  resolvedSubject: RemediationTriggerResult['resolvedSubject'],
  options: TriggerOptions,
): Promise<number> {
  const endpoint = tool.endpoint;
  if (endpoint === undefined) throw new Error('no endpoint to fire');

  // The EXACT per-endpoint body (verified against the middleware source). undefined
  // means the route takes no body (back-sync run-now). Gated endpoints add the NAV
  // write-gate password here (never logged); run-now has no body to attach one to.
  const body = buildRequestBody(tool, resolvedSubject, options);
  if (endpoint.gated === true && body !== undefined) {
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
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    // Any 2xx is success, including the fs-floor 202 Accepted (async apply).
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
  // Resolve the arm state + kill switch from runtime_settings with env fallback
  // (issue #97). In stub mode (no DB) this is exactly the env config, so the
  // disarmed-by-default posture and the existing tests are unchanged.
  const { remediationLiveEnabled, killSwitch } = await resolveRemediationFlags();
  const armed = remediationLiveEnabled && !killSwitch;
  const fireLive = armed && options.confirmed && isLiveExecutable(tool);
  const actor = options.actor ?? 'unknown';

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
      actor,
      toolId: tool.id,
      subjectKind: resolvedSubject?.subjectKind ?? null,
      subjectKey: resolvedSubject?.subjectKey ?? null,
      params: auditParams(tool, options.confirmed, options.dryRun !== false),
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
    const httpStatus = await firePost(tool, resolvedSubject, options);
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
