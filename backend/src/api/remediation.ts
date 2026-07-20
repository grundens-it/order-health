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
import { roleGate } from '../auth/principal';
import { buildUrl } from '../sources/middlewareClient';

// Per-request timeout for the read-only diagnostic proxies. A stalled middleware
// must fail fast into a 502, never block the operator's modal.
const DIAGNOSTIC_TIMEOUT_MS = 6000;

// Proxy one READ-ONLY middleware request server-side and hand the JSON back to the
// modal, so the browser never needs middleware network access. No password is ever
// attached (these are unauthenticated observability reads). Any failure degrades to
// a typed 502 / 503; nothing here mutates the middleware or NAV.
async function proxyMiddleware(
  reply: FastifyReply,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<FastifyReply> {
  if (config.middleware.baseUrl.length === 0) {
    return reply.code(503).send({ error: 'middleware base URL not configured' });
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method === 'POST') headers['content-type'] = 'application/json';
  // Bearer only if configured; the read endpoints are normally unauthenticated.
  if (config.middleware.authToken.length > 0) {
    headers.Authorization = `Bearer ${config.middleware.authToken}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIAGNOSTIC_TIMEOUT_MS);
  try {
    const res = await fetch(buildUrl(config.middleware.baseUrl, path), {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return reply.code(502).send({ error: `middleware responded ${res.status}`, status: res.status });
    }
    return reply.send({ ok: true, source: path, data: json });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return reply.code(502).send({ error: `middleware diagnostic unreachable: ${reason}` });
  } finally {
    clearTimeout(timer);
  }
}

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

      // ADMIN-ONLY LIVE WRITE (executable remediation). Operators keep read-only +
      // dry-run; only an Admin may cause an actual write. A confirmed fire WRITES
      // unless it is a dry-run preview on a dry-run-capable, not-held middleware
      // endpoint. Everything else that is live-executable (dryRun:false, or an
      // endpoint with no dry_run flag such as recovery replay / forward-sync replay
      // / back-sync run-now) is a write and requires Admin. ops_runbook and held
      // tools never write, so operators may confirm them (they return a preview).
      const isAdmin = roleGate(principal.roles, [APP_ROLES.admin]);
      const ep = tool.endpoint;
      const isLiveExecutable =
        tool.kind === 'middleware_endpoint' && ep !== undefined && ep.heldFromLivePath !== true;
      const isDryRunPreview = ep?.supportsDryRun === true && body.dryRun !== false;
      const wouldWriteLive = isLiveExecutable && body.confirmed === true && !isDryRunPreview;
      if (wouldWriteLive && !isAdmin) {
        return reply.code(403).send({
          error:
            'live remediation (an actual write) is Admin-only; operators may preview or dry-run. ' +
            'Re-run as a dry run, or ask an Admin to apply.',
        });
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
        // Thread the dry-run intent to the client. Undefined keeps the safe server
        // default (dry_run true) on endpoints that support it.
        dryRun: body.dryRun,
      });
    },
  );

  // --- Read-only diagnostic proxies (genuine_3pl_delay modal, FO Inspector) -----
  // These call the middleware's EXISTING read endpoints server-side and return the
  // JSON, so the modal never needs middleware network access from the browser. They
  // are READ ONLY: no password, no write, Operator OR Admin allowed. They mutate
  // nothing (the NAV inventory check is a read-only availability lookup).

  // GET /api/diagnostics/fulfillment-orders/:id -> middleware FO Inspector.
  app.get(
    '/api/diagnostics/fulfillment-orders/:id',
    async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const principal = requireRole(req, reply, [APP_ROLES.operator, APP_ROLES.admin]);
      if (principal === null) return reply;
      const id = (req.params as { id: string }).id;
      if (!/^\d+$/.test(id)) {
        return reply.code(400).send({ error: 'fulfillment-orders id must be a numeric Shopify order id' });
      }
      return proxyMiddleware(reply, 'GET', `/api/shopify/order/${id}/fulfillment-orders`);
    },
  );

  // GET /api/diagnostics/nav-inventory?sku=&location=&channel= -> middleware
  // POST /api/nav/inventory/check (a read-only per-SKU availability lookup).
  app.get(
    '/api/diagnostics/nav-inventory',
    async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const principal = requireRole(req, reply, [APP_ROLES.operator, APP_ROLES.admin]);
      if (principal === null) return reply;
      const q = req.query as { sku?: string; location?: string; channel?: string };
      const sku = (q.sku ?? '').trim();
      if (sku.length === 0) {
        return reply.code(400).send({ error: 'sku query parameter is required' });
      }
      const invBody: Record<string, unknown> = { skus: [sku] };
      if (q.location && q.location.trim().length > 0) invBody.locations = [q.location.trim()];
      if (q.channel && q.channel.trim().length > 0) invBody.channel = q.channel.trim();
      return proxyMiddleware(reply, 'POST', '/api/nav/inventory/check', invBody);
    },
  );
}
