// Unit coverage for the migrate-on-boot planner. The actual SQL apply is an
// integration concern proven by the docker migrate-on-boot smoke; here we pin
// the ordering + guard logic (the part that decides WHAT runs) with fed inputs,
// mirroring the docker-compose migrate service contract.
import assert from 'node:assert/strict';
import test from 'node:test';
import { planMigrations } from './migrate.js';

const FILES = ['0002_order_classification.sql', '0001_init.sql'];

test('applies every migration in filename order when the base table is absent', () => {
  const plan = planMigrations(FILES, false);
  assert.deepEqual(
    plan.map((p) => p.file),
    ['0001_init.sql', '0002_order_classification.sql'],
    'sorted by filename regardless of input order',
  );
  assert.deepEqual(plan.map((p) => p.action), ['apply', 'apply']);
});

test('skips 0001 when the base table already exists, still applies later migrations', () => {
  const plan = planMigrations(FILES, true);
  const base = plan.find((p) => p.file === '0001_init.sql');
  const later = plan.find((p) => p.file === '0002_order_classification.sql');
  assert.equal(base?.action, 'skip', '0001 is guarded on the base table');
  assert.equal(later?.action, 'apply', 'later migrations always re-apply (idempotent)');
});

test('ignores non-sql files', () => {
  const plan = planMigrations(['0001_init.sql', 'README.md', 'notes.txt'], false);
  assert.deepEqual(plan.map((p) => p.file), ['0001_init.sql']);
});

test('an empty migration set yields an empty plan', () => {
  assert.deepEqual(planMigrations([], false), []);
});
