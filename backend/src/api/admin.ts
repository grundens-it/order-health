// Admin arm/disarm + kill-switch API (issue #97) and the principal echo the
// frontend uses to decide whether to render the Admin panel (issue #96).
//
// The two PUT routes are ADMIN-ONLY: a non-Admin never reaches the write. Each
// write upserts the runtime_settings row AND appends an audit entry (who / when /
// what), then returns the freshly-resolved arm state. GET is Admin-only too (it
// exposes the security posture). /api/auth/me is open to any authenticated
// principal so the SPA can gate the panel's visibility client-side; the server is
// the real gate on every write.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  AuthMeResponse,
  RemediationArmStateResponse,
  SetArmedInput,
  SetKillSwitchInput,
} from '@order-health/shared';
import { APP_ROLES } from '@order-health/shared';
import { requireRole, resolvePrincipal } from '../auth/context';
import {
  KEY_KILL_SWITCH,
  KEY_LIVE_ENABLED,
  getArmState,
  setRemediationFlag,
} from '../runtime/runtimeSettings';

// A runtime_settings write needs a DB; in stub mode we return a clear 503 rather
// than silently no-op a security-relevant change.
function isNoDbError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('require a database');
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  // The resolved principal, so the SPA can show/hide the Admin panel. Any
  // authenticated principal may read its own identity.
  app.get('/api/auth/me', async (req: FastifyRequest): Promise<AuthMeResponse> => {
    const principal = resolvePrincipal(req);
    return { as_of: new Date().toISOString(), ...principal };
  });

  // Current arm state + kill switch (Admin-only): the effective posture plus each
  // flag's source (runtime override vs env default) and who last changed it.
  app.get(
    '/api/admin/arm-state',
    async (req: FastifyRequest, reply: FastifyReply): Promise<RemediationArmStateResponse | undefined> => {
      if (requireRole(req, reply, [APP_ROLES.admin]) === null) return undefined;
      const state = await getArmState();
      return { as_of: new Date().toISOString(), ...state };
    },
  );

  // Arm / disarm the executable remediation path (Admin-only).
  app.put(
    '/api/admin/arm-state',
    async (req: FastifyRequest, reply: FastifyReply): Promise<RemediationArmStateResponse | { error: string } | undefined> => {
      const principal = requireRole(req, reply, [APP_ROLES.admin]);
      if (principal === null) return undefined;
      const body = (req.body ?? {}) as Partial<SetArmedInput>;
      if (typeof body.armed !== 'boolean') {
        return reply.code(400).send({ error: 'body.armed (boolean) is required' });
      }
      try {
        await setRemediationFlag(KEY_LIVE_ENABLED, body.armed, principal.name, new Date().toISOString());
      } catch (err) {
        if (isNoDbError(err)) return reply.code(503).send({ error: 'runtime settings unavailable: no database configured' });
        throw err;
      }
      const state = await getArmState();
      return { as_of: new Date().toISOString(), ...state };
    },
  );

  // Flip the global kill switch (Admin-only). true forces DISARMED regardless of
  // the arm flag, so a live path can be shut off instantly without a redeploy.
  app.put(
    '/api/admin/kill-switch',
    async (req: FastifyRequest, reply: FastifyReply): Promise<RemediationArmStateResponse | { error: string } | undefined> => {
      const principal = requireRole(req, reply, [APP_ROLES.admin]);
      if (principal === null) return undefined;
      const body = (req.body ?? {}) as Partial<SetKillSwitchInput>;
      if (typeof body.killed !== 'boolean') {
        return reply.code(400).send({ error: 'body.killed (boolean) is required' });
      }
      try {
        await setRemediationFlag(KEY_KILL_SWITCH, body.killed, principal.name, new Date().toISOString());
      } catch (err) {
        if (isNoDbError(err)) return reply.code(503).send({ error: 'runtime settings unavailable: no database configured' });
        throw err;
      }
      const state = await getArmState();
      return { as_of: new Date().toISOString(), ...state };
    },
  );
}
