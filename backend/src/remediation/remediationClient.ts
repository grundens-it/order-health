// Remediation client (Unit 7, design.md 5A.4).
//
// BOUNDARY (read carefully): this is the ONLY place remediation is invoked, and it
// invokes ONLY on an EXPLICIT operator action routed through api/remediation.ts.
// It NEVER fires automatically and is NEVER imported by the aggregator. It calls
// the middleware's EXISTING authenticated endpoints (or names a documented ops
// runbook); it adds NO new middleware endpoint and makes NAV nothing but read-only.
//
// STUB STATUS: middleware auth is DevOps-gated, so this documents the REAL
// authenticated call shape but performs NO live call. Every trigger returns a
// typed 'would_trigger' result. A tiny in-memory invocation log lets the tests
// assert the no-auto-trigger invariant (the aggregator path leaves it empty; only
// the operator path appends to it).
import type { RemediationTool, RemediationTriggerResult } from '@order-health/shared';

// In-memory audit of operator triggers (test hook + operator event record). Never
// touched by the aggregator; grows only on the explicit operator path.
export interface RemediationInvocation {
  at: string;
  toolId: string;
  live: false; // always false: no live call is ever made in v1 (stubbed)
}
const invocationLog: RemediationInvocation[] = [];

// Test/inspection hook: the recorded operator triggers so far.
export function getInvocationLog(): readonly RemediationInvocation[] {
  return invocationLog;
}
export function __resetInvocationLogForTest(): void {
  invocationLog.length = 0;
}

// The documented authenticated call shape a tool WOULD issue, or its ops step.
function wouldCallDescription(tool: RemediationTool): string {
  if (tool.kind === 'middleware_endpoint' && tool.endpoint) {
    // The real call is authenticated (Authorization: Bearer <MIDDLEWARE_AUTH_TOKEN>,
    // DevOps-provisioned). We document it; we do not fire it.
    return `${tool.endpoint.method} ${tool.endpoint.path} (Authorization: Bearer <middleware token>) -> ${tool.endpoint.source}`;
  }
  if (tool.runbook) {
    const diag = tool.runbook.diagnostic ? `diagnose: ${tool.runbook.diagnostic}; ` : '';
    return `${diag}ops runbook ${tool.runbook.ref}${tool.runbook.command ? `: ${tool.runbook.command}` : ''}`;
  }
  return 'no call shape available';
}

// Trigger a remediation ON EXPLICIT OPERATOR ACTION. Stubbed: records the operator
// intent and returns a typed 'would_trigger' result. NO live HTTP call is made.
export function triggerRemediation(
  tool: RemediationTool,
  resolvedSubject: RemediationTriggerResult['resolvedSubject'],
  nowIso: string,
): RemediationTriggerResult {
  invocationLog.push({ at: nowIso, toolId: tool.id, live: false });
  // eslint-disable-next-line no-console
  console.info(
    `[remediation:stub] operator triggered "${tool.id}"; WOULD run: ${wouldCallDescription(tool)} (no live call made)`,
  );
  return {
    status: 'would_trigger',
    as_of: nowIso,
    toolId: tool.id,
    toolName: tool.name,
    kind: tool.kind,
    wouldCall: wouldCallDescription(tool),
    message: `Would trigger "${tool.name}" (operator-confirmed). No live call is made in v1; DevOps wires the authenticated call.`,
    resolvedSubject,
  };
}
