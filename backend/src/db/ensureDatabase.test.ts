// Unit coverage for the self-healing database planner. The actual CREATE
// DATABASE is I/O, proven by the docker self-heal smoke; here we pin the pure
// parse-and-plan logic: extracting the target db name, building the maintenance
// (/postgres) URL with credentials + query params preserved, and the
// create-vs-skip decision.
import assert from 'node:assert/strict';
import test from 'node:test';
import { planDatabaseEnsure, decideEnsureAction } from './ensureDatabase.js';

test('parses the target database and builds a /postgres maintenance URL', () => {
  const plan = planDatabaseEnsure(
    'postgres://oh:secret@db.example.com:5432/order_health',
  );
  assert.ok(plan, 'a normal URL yields a plan');
  assert.equal(plan.target, 'order_health');
  const admin = new URL(plan.adminUrl);
  assert.equal(admin.pathname, '/postgres', 'path swapped to the maintenance db');
  assert.equal(admin.hostname, 'db.example.com', 'host preserved');
  assert.equal(admin.port, '5432', 'port preserved');
  assert.equal(admin.username, 'oh', 'user preserved');
  assert.equal(admin.password, 'secret', 'password preserved');
});

test('preserves ssl query params on the maintenance URL', () => {
  const plan = planDatabaseEnsure(
    'postgres://oh:secret@grundens.postgres.database.azure.com:5432/order_health?sslmode=require',
  );
  assert.ok(plan);
  assert.equal(plan.target, 'order_health');
  const admin = new URL(plan.adminUrl);
  assert.equal(admin.pathname, '/postgres');
  assert.equal(
    admin.searchParams.get('sslmode'),
    'require',
    'sslmode carried over so admin SSL handling matches the target',
  );
});

test('returns null in stub mode (empty URL)', () => {
  assert.equal(planDatabaseEnsure(''), null);
});

test('returns null for an unparseable URL', () => {
  assert.equal(planDatabaseEnsure('not a url'), null);
});

test('returns null when the URL has no database name in its path', () => {
  assert.equal(
    planDatabaseEnsure('postgres://oh:secret@db.example.com:5432/'),
    null,
  );
});

test('decodes a percent-encoded database name', () => {
  const plan = planDatabaseEnsure(
    'postgres://oh:secret@db.example.com:5432/order%20health',
  );
  assert.ok(plan);
  assert.equal(plan.target, 'order health');
});

test('decides create when absent and skip when present', () => {
  assert.equal(decideEnsureAction(false), 'create');
  assert.equal(decideEnsureAction(true), 'skip');
});
