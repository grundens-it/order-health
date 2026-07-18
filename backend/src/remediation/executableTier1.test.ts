// Executable remediation Tier 1 safety invariants (ADR-0010). These pin the
// disarmed-by-default contract on remediationClient: no live HTTP call escapes
// unless the path is armed, not kill-switched, operator-confirmed, and the tool is
// a live-executable middleware_endpoint. We spy on global fetch to prove a call is
// (or is not) made, and mutate the shared config object to flip the gates.
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { config } from '../config.js';
import { getRemediationTool } from './registry.js';
import {
  __resetRemediationAuditLogForTest,
  getRemediationAuditLog,
  triggerRemediation,
} from './remediationClient.js';

const NOW = '2026-07-14T12:00:00.000Z';
const SUBJECT = { subjectKind: 'signal', subjectKey: 'missed_back_sync' } as const;

// --- fetch spy -------------------------------------------------------------
interface Captured {
  url: string;
  init: RequestInit | undefined;
}
let calls: Captured[] = [];
const realFetch = globalThis.fetch;
// Snapshot the config fields these tests mutate so each test starts from a known
// (disarmed) posture and the suite leaves config untouched.
const savedConfig = {
  liveEnabled: config.remediation.liveEnabled,
  killSwitch: config.remediation.killSwitch,
  togglePassword: config.remediation.togglePassword,
  baseUrl: config.middleware.baseUrl,
  authToken: config.middleware.authToken,
};

function installFetchSpy(status = 200): void {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({}),
    } as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  __resetRemediationAuditLogForTest();
  // Disarmed default posture; individual tests arm as needed.
  config.remediation.liveEnabled = false;
  config.remediation.killSwitch = false;
  config.remediation.togglePassword = '';
  config.middleware.baseUrl = 'https://middleware.test';
  config.middleware.authToken = '';
  installFetchSpy();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  config.remediation.liveEnabled = savedConfig.liveEnabled;
  config.remediation.killSwitch = savedConfig.killSwitch;
  config.remediation.togglePassword = savedConfig.togglePassword;
  config.middleware.baseUrl = savedConfig.baseUrl;
  config.middleware.authToken = savedConfig.authToken;
});

function tool(id: string) {
  const t = getRemediationTool(id);
  assert.ok(t !== null, `tool ${id} exists`);
  return t;
}

// --- 1. Disarmed returns would_trigger and makes NO live call --------------
test('disarmed (default): confirmed trigger returns would_trigger and makes no HTTP call', async () => {
  const result = await triggerRemediation(tool('recovery_sweep'), SUBJECT, NOW, { confirmed: true });
  assert.equal(result.status, 'would_trigger');
  assert.equal(result.live, false);
  assert.equal(calls.length, 0, 'no fetch when disarmed');
  assert.equal(getRemediationAuditLog().at(-1)?.outcome, 'would_trigger');
});

// --- 2. Kill switch forces disarmed even when armed + confirmed ------------
test('kill switch forces disarmed: armed + confirmed still previews, no HTTP call', async () => {
  config.remediation.liveEnabled = true;
  config.remediation.killSwitch = true;
  const result = await triggerRemediation(tool('recovery_sweep'), SUBJECT, NOW, { confirmed: true });
  assert.equal(result.status, 'would_trigger');
  assert.equal(result.live, false);
  assert.equal(calls.length, 0, 'kill switch blocks the live call');
});

// --- 3. confirmed:false never fires, even when armed ----------------------
test('confirmed:false never fires: armed but unconfirmed returns would_trigger, no HTTP call', async () => {
  config.remediation.liveEnabled = true;
  const result = await triggerRemediation(tool('recovery_sweep'), SUBJECT, NOW, { confirmed: false });
  assert.equal(result.status, 'would_trigger');
  assert.equal(result.live, false);
  assert.equal(calls.length, 0, 'no fetch without confirmation');
});

// --- 4. ops_runbook tools NEVER mutate ------------------------------------
test('ops_runbook never mutates: armed + confirmed returns would_trigger, no HTTP call', async () => {
  config.remediation.liveEnabled = true;
  const result = await triggerRemediation(tool('atomic_watcher_restart'), SUBJECT, NOW, { confirmed: true });
  assert.equal(result.kind, 'ops_runbook');
  assert.equal(result.status, 'would_trigger');
  assert.equal(calls.length, 0, 'ops_runbook makes no live call');
});

// --- 5. Held-out destructive action stays disarmed ------------------------
test('stuck_staging_dedupe is held out: armed + confirmed still previews, no HTTP call', async () => {
  config.remediation.liveEnabled = true;
  config.remediation.togglePassword = 'unused';
  const dedupe = tool('stuck_staging_dedupe');
  assert.equal(dedupe.endpoint?.heldFromLivePath, true, 'dedupe endpoint is held out');
  const result = await triggerRemediation(dedupe, SUBJECT, NOW, { confirmed: true });
  assert.equal(result.status, 'would_trigger');
  assert.equal(result.live, false);
  assert.equal(calls.length, 0, 'held-out action never fires a live call');
});

// --- 6. Armed + confirmed + live-executable middleware_endpoint FIRES ------
test('armed + confirmed live fire: gated tool POSTs with Bearer + password (never logged)', async () => {
  config.remediation.liveEnabled = true;
  config.middleware.authToken = 'mw-token';
  config.remediation.togglePassword = 'nav-pw';

  const result = await triggerRemediation(tool('recovery_sweep'), SUBJECT, NOW, { confirmed: true });
  assert.equal(result.status, 'triggered');
  assert.equal(result.live, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(calls.length, 1, 'exactly one live POST');

  const [{ url, init }] = calls;
  assert.match(url, /\/api\/recovery\/replay-fulfillment-requests$/);
  assert.equal(init?.method, 'POST');
  const headers = init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer mw-token');
  const body = JSON.parse(String(init?.body));
  assert.equal(body.password, 'nav-pw', 'gated tool sends the NAV toggle password');
  assert.equal(body.set_by, 'order-health-operator');

  // The audit log records the execution but NEVER the password or the token.
  const entry = getRemediationAuditLog().at(-1);
  assert.equal(entry?.outcome, 'triggered');
  const serialised = JSON.stringify(entry);
  assert.ok(!serialised.includes('nav-pw'), 'audit log must not contain the password');
  assert.ok(!serialised.includes('mw-token'), 'audit log must not contain the bearer token');
});

// --- 6b. A non-gated live-executable tool fires WITHOUT the password -------
test('armed + confirmed live fire: non-gated tool omits the password', async () => {
  config.remediation.liveEnabled = true;
  config.middleware.authToken = 'mw-token';
  config.remediation.togglePassword = 'nav-pw';

  const result = await triggerRemediation(tool('submit_fulfillment_request'), SUBJECT, NOW, { confirmed: true });
  assert.equal(result.status, 'triggered');
  assert.equal(calls.length, 1);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.password, undefined, 'non-gated tool sends no password');
});

// --- 6c. A failed live POST returns a typed error, never throws -----------
test('a non-2xx live response returns a typed error result (no throw)', async () => {
  installFetchSpy(503);
  config.remediation.liveEnabled = true;
  config.middleware.authToken = 'mw-token';

  const result = await triggerRemediation(tool('submit_fulfillment_request'), SUBJECT, NOW, { confirmed: true });
  assert.equal(result.status, 'error');
  assert.equal(result.live, true);
  assert.match(result.error ?? '', /HTTP 503/);
  assert.equal(getRemediationAuditLog().at(-1)?.outcome, 'error');
});
