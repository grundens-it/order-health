// Migrate-on-boot runner for THIS service's own Postgres datastore.
//
// The container ships db/migrations/*.sql inside the image (see Dockerfile) and
// applies them on startup BEFORE the server serves and BEFORE the aggregator
// cron starts (see index.ts). This is what makes a push to main fully own the
// schema: there is no separate migrate job and no local psql step.
//
// The apply logic mirrors the docker-compose `migrate` service exactly:
//   - 0001 (the base schema) is guarded on whether order_health_snapshot exists,
//     so a re-run never fails on "type/table already exists".
//   - later migrations (0002+) are additive and already idempotent
//     (ADD COLUMN IF NOT EXISTS, wrapped in their own transaction), so they are
//     always safe to re-apply.
// In stub mode (no DATABASE_URL) there is nothing to migrate and the runner is a
// clean no-op, so the scaffold still boots without a database.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config, hasDatabase } from '../config.js';
import { pgConnectionConfig } from './pgConfig.js';

// The migrations ship at <image>/db/migrations. This module lives at
// backend/src/db/migrate.ts, so three levels up is the repo/app root in both the
// container (/app) and local dev (the checkout root), where db/migrations sits.
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

// The base migration is guarded on the base table; every other file is applied
// unconditionally because it is written to be idempotent. Matches the compose
// `grep -v 0001_init` split.
const BASE_MIGRATION = /0001_init/;

export interface MigrationPlanEntry {
  file: string;
  action: 'apply' | 'skip';
  reason: string;
}

// Pure planning step: given the migration filenames and whether the base table
// already exists, decide what to apply and in what order. Kept side-effect-free
// so the ordering and guard logic is unit-testable without a database.
export function planMigrations(files: string[], baseTableExists: boolean): MigrationPlanEntry[] {
  const sorted = files.filter((f) => f.endsWith('.sql')).sort();
  return sorted.map((file) => {
    if (BASE_MIGRATION.test(file)) {
      return baseTableExists
        ? { file, action: 'skip', reason: 'base table public.order_health_snapshot already present' }
        : { file, action: 'apply', reason: 'base schema not yet applied' };
    }
    return { file, action: 'apply', reason: 'idempotent migration, safe to re-run' };
  });
}

type Logger = (message: string) => void;

const defaultLog: Logger = (message) => {
  // eslint-disable-next-line no-console
  console.info(`[migrate] ${message}`);
};

// Apply the migrations found in `dir` to the DATABASE_URL database, in filename
// order, using the guard logic above. Uses a single dedicated pg Client (the
// pool is for the request/aggregator paths). Runs once at boot; on any error it
// throws so the container fails fast instead of serving on an unmigrated schema.
export async function runMigrations(
  opts: { dir?: string; log?: Logger } = {},
): Promise<void> {
  const log = opts.log ?? defaultLog;

  if (!hasDatabase()) {
    log('DATABASE_URL not set: stub mode, skipping migrations');
    return;
  }

  const dir = opts.dir ?? DEFAULT_MIGRATIONS_DIR;
  if (!fs.existsSync(dir)) {
    log(`migrations directory not found at ${dir}: nothing to apply`);
    return;
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  if (files.length === 0) {
    log(`no .sql migrations in ${dir}: nothing to apply`);
    return;
  }

  const client = new pg.Client(pgConnectionConfig(config.database.url));
  await client.connect();
  try {
    const reg = await client.query<{ reg: string | null }>(
      "SELECT to_regclass('public.order_health_snapshot') AS reg",
    );
    const baseTableExists = reg.rows[0]?.reg != null;

    const plan = planMigrations(files, baseTableExists);
    for (const entry of plan) {
      if (entry.action === 'skip') {
        log(`skip ${entry.file} (${entry.reason})`);
        continue;
      }
      log(`apply ${entry.file} (${entry.reason})`);
      const sql = fs.readFileSync(path.join(dir, entry.file), 'utf8');
      await client.query(sql);
    }
    log(`migrations complete (${plan.filter((p) => p.action === 'apply').length} applied)`);
  } finally {
    await client.end();
  }
}
