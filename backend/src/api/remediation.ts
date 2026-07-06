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
import type { RemediationRegistryResponse, RemediationTriggerResult } from '@order-health/shared';
import { config } from '../config';
import {
  REMEDIATION_MAPPINGS,
  REMEDIATION_TOOLS,
  getRemediationTool,
} from '../remediation/registry';
import { triggerRemediation } from '../remediation/remediationClient';
import { resolveForRemediation } from '../repo/transitionRepo';
import type { SubjectKind } from '../aggregator/transitions';

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

interface TriggerBody {
  subjectKind?: SubjectKind;
  subjectKey?: string;
}

export async function registerRemediationRoutes(app: FastifyInstance): Promise<void> {
  // The runbook registry, read-only, with as_of (firm rule). The modal reads this
  // to name the mapped tool for a red signal; it never re-declares the runbook.
  app.get('/api/remediation/registry', async (): Promise<RemediationRegistryResponse> => ({
    as_of: new Date().toISOString(),
    tools: [...REMEDIATION_TOOLS],
    mappings: [...REMEDIATION_MAPPINGS],
  }));

  // Operator trigger. Authenticated; invokes the mapped tool via the stubbed
  // client (no live call) and records the resolution event.
  app.post(
    '/api/remediation/:tool/trigger',
    async (req: FastifyRequest, reply: FastifyReply): Promise<RemediationTriggerResult | { error: string }> => {
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

      // The stubbed invocation: typed 'would_trigger', no live call.
      return triggerRemediation(tool, resolvedSubject, nowIso);
    },
  );
}
