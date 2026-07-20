// Remediation API (Unit 7, design.md 5A.4).
//
// BOUNDARY: one READ endpoint that serves the runbook registry (so the frontend
// modal can name the mapped tool for a red signal), and one authenticated POST
// endpoint that, ONLY on explicit operator action, invokes the mapped tool via the
// STUBBED remediationClient (typed 'would_trigger', no live call) and records the
// resolution as a health_transition event. This service adds NO new middleware
// endpoint; the trigger routes to the middleware's EXISTING authenticated paths
// (or a documented ops runbook). It NEVER auto-fires: nothing here is on a cadence.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  RemediationRegistryResponse,
  RemediationTriggerInput,
  RemediationTriggerResult,
} from '@order-health/shared';
import { APP_ROLES } from '@order-health/shared';
import { config } from '../config';
import {
  REMEDIATION_MAPPINGS,
  REMEDIATION_TOOLS,
  getRemediationTool,
} from '../remediation/registry';
import { triggerRemediation } from '../remediation/remediationClient';
import { resolveForRemediation } from '../repo/transitionRepo';
import { resolveRemediationFlags } from '../runtime/runtimeSettings';
import { requireRole } from '../auth/context';

// Operator gate. When REMEDIATION_OPERATOR_TOKEN is set, require a matching
// Authorization: Bearer / x-operator-token header. When empty (scaffold) it logs
// and allows so the demo runs without provisioning. Returns true when allowed.
function assertOperator(req: FastifyRequest): boolean {
  const expected = config.remediation.operatorToken;
  if (expected.length === 0) {
    // eslint-disable-next-line no-console
    console.info('[remediation] no REMEDIATION_OPERATOR_TOKEN set; allowing operator trigger (scaffold posture)');
    return true;
  }
  const auth = req.headers.authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  const header = (req.headers['x-operator-token'] as string | undefined) ?? '';
  return bearer === expected || header === expected;
}

type TriggerBody = RemediationTriggerInput;

export async function registerRemediationRoutes(app: FastifyInstance): Promise<void> {
  // The runbook registry, read-only, with as_of (firm rule). The modal reads this
  // to name the mapped tool for a red signal; it never re-declares the runbook.
  app.get('/api/remediation/registry', async (): Promise<RemediationRegistryResponse> => ({
    as_of: new Date().toISOString(),
    tools: [...REMEDIATION_TOOLS],
    mappings: [...REMEDIATION_MAPPINGS],
  }));

  // Operator trigger (executable Tier 1, ADR-0010). Authenticated; invokes the
  // mapped tool via remediationClient and records the resolution event. The client
  // is DISARMED by default: a live middleware call fires ONLY when the path is armed,
  // not kill-switched, AND the operator confirmed (body.confirmed === true). This
  // route enforces the confirm gate and the kill switch as defence in depth so a
  // stray or unconfirmed POST can never fire a mutation; the client re-checks both.
  app.post(
    '/api/remediation/:tool/trigger',
    async (req: FastifyRequest, reply: FastifyReply): Promise<RemediationTriggerResult | { error: string }> => {
      // RBAC (issue #96): triggering remediation requires Operator OR Admin. The
      // typed 403 is sent by requireRole; a null return means the gate denied.
      const principal = requireRole(req, reply, [APP_ROLES.operator, APP_ROLES.admin]);
      if (principal === null) return reply;
      // The existing operator-token gate stays as defence in depth alongside RBAC.
      if (!assertOperator(req)) {
        return reply.code(401).send({ error: 'operator token required' });
      }
      const toolId = (req.params as { tool: string }).tool;
      const tool = getRemediationTool(toolId);
      if (tool === null) {
        return reply.code(404).send({ error: `unknown remediation tool: ${toolId}` });
      }

      const body = (req.body ?? {}) as TriggerBody;
      const nowIso = new Date().toISOString();

      // Record the resolution event on the open transition for the subject (if the
      // operator named one). No-op without a DB; never blocks the trigger result.
      let resolvedSubject: RemediationTriggerResult['resolvedSubject'] = null;
      if (body.subjectKind && body.subjectKey) {
        const resolved = await resolveForRemediation(
          body.subjectKind,
          body.subjectKey,
          `remediated via ${tool.id}`,
          nowIso,
        );
        if (resolved) resolvedSubject = { subjectKind: body.subjectKind, subjectKey: body.subjectKey };
      }

      // The confirm gate + kill switch, enforced here before the client sees a live
      // intent. A live fire requires an explicit confirmed:true AND the kill switch
      // off; otherwise we pass confirmed:false so the client returns the disarmed
      // preview and never issues an HTTP call. The client records the audit entry.
      // Resolve the kill switch from runtime_settings with env fallback (issue #97)
      // so an Admin can disarm live from the panel without a redeploy.
      const { killSwitch } = await resolveRemediationFlags();
      const confirmed = body.confirmed === true && killSwitch === false;
      return triggerRemediation(tool, resolvedSubject, nowIso, {
        confirmed,
        actor: principal.name,
      });
    },
  );
}
