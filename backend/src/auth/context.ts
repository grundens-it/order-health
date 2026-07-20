// Route-layer auth wiring (issue #96). Resolves the request Principal from the
// Easy Auth header, applies the configurable dev fallback when the header is
// absent, and offers requireRole() so a handler can gate on roles and send the
// typed 403 body. The PURE parse/gate live in ./principal.ts; this file is the
// impure edge (it reads config and logs), kept thin on purpose.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ForbiddenBody, Principal } from '@order-health/shared';
import { config } from '../config';
import { parseClientPrincipal, roleGate } from './principal';

// Easy Auth injects this header (lower-cased by Fastify). Absent => not behind
// Easy Auth (local dev), so the dev fallback principal applies.
const PRINCIPAL_HEADER = 'x-ms-client-principal';

// Log the dev-mode fallback once per process, not on every request.
let loggedDevMode = false;

// Resolve the authenticated Principal for a request. When the Easy Auth header is
// present it is parsed; when it is absent (or malformed) the configured dev
// principal is returned and a one-time dev-mode notice is logged.
export function resolvePrincipal(req: FastifyRequest): Principal {
  const header = req.headers[PRINCIPAL_HEADER];
  const raw = Array.isArray(header) ? header[0] : header;
  const parsed = parseClientPrincipal(raw);
  if (parsed !== null) return parsed;

  if (!loggedDevMode) {
    loggedDevMode = true;
    // eslint-disable-next-line no-console
    console.info(
      `[auth] no ${PRINCIPAL_HEADER} header (Easy Auth not in front): using DEV principal "${config.auth.devPrincipalName}" with roles [${config.auth.devPrincipalRoles.join(', ')}]`,
    );
  }
  return { name: config.auth.devPrincipalName, roles: [...config.auth.devPrincipalRoles] };
}

// Gate a handler on roles. Returns the resolved Principal when allowed; otherwise
// sends a typed 403 ForbiddenBody and returns null so the caller returns early.
export function requireRole(
  req: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: readonly string[],
): Principal | null {
  const principal = resolvePrincipal(req);
  if (roleGate(principal.roles, allowedRoles)) return principal;
  const body: ForbiddenBody = {
    error: `requires one of role: ${allowedRoles.join(', ')}`,
    code: 'forbidden',
    requiredRoles: [...allowedRoles],
    principalRoles: principal.roles,
  };
  reply.code(403).send(body);
  return null;
}
