// RBAC principal parsing (issue #96). PURE, side-effect-free, and independent of
// config so it unit-tests cleanly against fed headers.
//
// The app runs behind Entra Easy Auth, which injects X-MS-CLIENT-PRINCIPAL: a
// base64-encoded JSON blob { auth_typ, claims: [{ typ, val }, ...] }. Roles arrive
// as claims of type 'roles' (Entra app roles); the display name comes from
// preferred_username / name / upn. This module ONLY parses and decides; the dev
// fallback and the route wiring live in ./context.ts so the pure functions stay
// testable without an environment.
import type { Principal } from '@order-health/shared';

// Claim types Easy Auth uses. Roles are 'roles'; the name may arrive under any of
// these, most-preferred first.
const ROLE_CLAIM_TYPES = ['roles', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role'];
const NAME_CLAIM_TYPES = ['preferred_username', 'name', 'upn', 'email'];

interface RawClaim {
  typ?: unknown;
  val?: unknown;
}
interface RawPrincipal {
  claims?: unknown;
}

function claimVal(claims: RawClaim[], types: string[]): string | null {
  for (const type of types) {
    const hit = claims.find((c) => typeof c.typ === 'string' && c.typ === type && typeof c.val === 'string');
    if (hit) return hit.val as string;
  }
  return null;
}

// Parse the X-MS-CLIENT-PRINCIPAL header value into a Principal, or null when the
// header is absent or malformed (so the caller can apply the dev fallback). Never
// throws: a bad base64 / JSON blob returns null rather than crashing the request.
export function parseClientPrincipal(headerValue: string | undefined | null): Principal | null {
  if (headerValue === undefined || headerValue === null || headerValue.length === 0) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(headerValue, 'base64').toString('utf8');
  } catch {
    return null;
  }
  let raw: RawPrincipal;
  try {
    raw = JSON.parse(decoded) as RawPrincipal;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.claims)) return null;
  const claims = raw.claims as RawClaim[];
  const roles = claims
    .filter((c) => typeof c.typ === 'string' && ROLE_CLAIM_TYPES.includes(c.typ as string) && typeof c.val === 'string')
    .map((c) => c.val as string);
  const name = claimVal(claims, NAME_CLAIM_TYPES) ?? 'unknown';
  return { name, roles };
}

// The pure role-gate decision: allow when the caller carries ANY of the allowed
// roles. Used for both the Operator-OR-Admin trigger gate and the Admin-only
// arm/disarm gate. No implicit hierarchy: callers pass the full allowed set.
// Role names may arrive namespaced ('OrderHealth.Admin') or bare ('Admin')
// depending on the Entra app-role `value`, and a value change lags in issued
// tokens. Compare on the last dotted segment so both forms satisfy the gate.
// The roles claim is scoped to THIS app's assignments, so matching the bare
// suffix carries no cross-app collision risk.
function bareRole(r: string): string {
  const i = r.lastIndexOf('.');
  return i >= 0 ? r.slice(i + 1) : r;
}

export function roleGate(principalRoles: readonly string[], allowedRoles: readonly string[]): boolean {
  const allowed = new Set(allowedRoles.map(bareRole));
  return principalRoles.some((r) => allowed.has(bareRole(r)));
}
