// Unit coverage for the PURE RBAC parse + gate (issue #96). Fed base64 headers
// and the missing-header case; the dev fallback + route wiring are exercised
// elsewhere (they read config / the request), so this pins only the pure core.
import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_ROLES } from '@order-health/shared';
import { parseClientPrincipal, roleGate } from './principal.js';

// Build an Easy-Auth-style X-MS-CLIENT-PRINCIPAL header value from claims.
function header(claims: { typ: string; val: string }[]): string {
  return Buffer.from(JSON.stringify({ auth_typ: 'aad', claims }), 'utf8').toString('base64');
}

test('parses the name and every roles claim from a base64 header', () => {
  const h = header([
    { typ: 'preferred_username', val: 'jane@grundens.com' },
    { typ: 'roles', val: APP_ROLES.admin },
    { typ: 'roles', val: APP_ROLES.operator },
    { typ: 'aud', val: 'ignored' },
  ]);
  const p = parseClientPrincipal(h);
  assert.ok(p !== null);
  assert.equal(p.name, 'jane@grundens.com');
  assert.deepEqual(p.roles, [APP_ROLES.admin, APP_ROLES.operator]);
});

test('falls back through name claim types (name when preferred_username absent)', () => {
  const p = parseClientPrincipal(header([{ typ: 'name', val: 'Ops Bot' }, { typ: 'roles', val: APP_ROLES.viewer }]));
  assert.equal(p?.name, 'Ops Bot');
  assert.deepEqual(p?.roles, [APP_ROLES.viewer]);
});

test('a principal with no roles claim yields an empty roles array (not null)', () => {
  const p = parseClientPrincipal(header([{ typ: 'preferred_username', val: 'nobody@grundens.com' }]));
  assert.ok(p !== null);
  assert.deepEqual(p.roles, []);
  assert.equal(p.name, 'nobody@grundens.com');
});

test('missing header returns null (so the caller applies the dev fallback)', () => {
  assert.equal(parseClientPrincipal(undefined), null);
  assert.equal(parseClientPrincipal(null), null);
  assert.equal(parseClientPrincipal(''), null);
});

test('malformed base64 / non-JSON / wrong shape returns null, never throws', () => {
  assert.equal(parseClientPrincipal('%%%not-base64%%%'), null);
  assert.equal(parseClientPrincipal(Buffer.from('not json', 'utf8').toString('base64')), null);
  assert.equal(parseClientPrincipal(Buffer.from(JSON.stringify({ nope: 1 }), 'utf8').toString('base64')), null);
});

// --- role-gate decisions ---------------------------------------------------
test('trigger gate (Operator OR Admin): operator and admin allowed, viewer denied', () => {
  const allowed = [APP_ROLES.operator, APP_ROLES.admin];
  assert.equal(roleGate([APP_ROLES.operator], allowed), true);
  assert.equal(roleGate([APP_ROLES.admin], allowed), true);
  assert.equal(roleGate([APP_ROLES.viewer], allowed), false);
  assert.equal(roleGate([], allowed), false);
});

test('admin-only gate (arm / disarm / kill): only Admin allowed', () => {
  const adminOnly = [APP_ROLES.admin];
  assert.equal(roleGate([APP_ROLES.admin], adminOnly), true);
  assert.equal(roleGate([APP_ROLES.operator], adminOnly), false);
  assert.equal(roleGate([APP_ROLES.viewer], adminOnly), false);
  assert.equal(roleGate([APP_ROLES.operator, APP_ROLES.viewer], adminOnly), false);
});

test('role gate tolerates bare Entra values (Admin) and namespaced (OrderHealth.Admin)', () => {
  const adminOnly = [APP_ROLES.admin];
  const trigger = [APP_ROLES.operator, APP_ROLES.admin];
  // Bare token role (Entra value before propagation) still satisfies the gate.
  assert.equal(roleGate(['Admin'], adminOnly), true);
  assert.equal(roleGate(['Operator'], trigger), true);
  assert.equal(roleGate(['Viewer'], trigger), false);
  // A non-matching bare name is still denied.
  assert.equal(roleGate(['Reader'], adminOnly), false);
});
