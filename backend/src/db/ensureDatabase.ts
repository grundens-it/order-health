// Self-healing database creation for the migrate-on-boot path.
//
// The 2026-07-18 prod bring-up crashed on boot with
//   FATAL: database "order_health" does not exist
// because provisioning never ran CREATE DATABASE for the target. The connection
// itself was fine (SSL is handled in pgConfig.ts); only the target database was
// missing. This module makes a fresh server self-provisioning: before migrations
// run, it connects to the server's default `postgres` maintenance database and
// creates the target database if it is absent.
//
// CREATE DATABASE cannot run inside a transaction and has no IF NOT EXISTS, so
// the create is guarded on a pg_database lookup and a racing duplicate_database
// (SQLSTATE 42P04) is treated as benign. In stub mode (no DATABASE_URL) this is
// a clean no-op, unchanged.
import pg from 'pg';
import { config, hasDatabase } from '../config.js';
import { pgConnectionConfig } from './pgConfig.js';

export interface DatabaseEnsurePlan {
  // The target database name parsed from the DATABASE_URL path segment.
  target: string;
  // The maintenance connection URL: the same server/credentials/query params as
  // DATABASE_URL but with the path swapped to `/postgres`, so pgConnectionConfig
  // applies IDENTICAL SSL handling to the admin connection.
  adminUrl: string;
}

// Pure planning step: parse the target database name out of a DATABASE_URL and
// build the maintenance-database URL to create it from. Returns null when there
// is nothing to plan (empty/stub URL, unparseable URL, or no database name in
// the path), so the caller skips cleanly. Side-effect-free and unit-testable.
export function planDatabaseEnsure(url: string): DatabaseEnsurePlan | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // Empty string (stub mode) or an unparseable URL: nothing to ensure.
    return null;
  }

  const target = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (target.length === 0) {
    // No database name in the path: nothing to ensure.
    return null;
  }

  // Swap ONLY the path to the default maintenance database. Host, port,
  // credentials, and query params (e.g. sslmode) are preserved so the admin
  // connection is identical to the target connection in every way but the db.
  const admin = new URL(url);
  admin.pathname = '/postgres';
  return { target, adminUrl: admin.toString() };
}

export type EnsureAction = 'create' | 'skip';

// Pure decision step: given whether the target database already exists, decide
// whether to CREATE it or skip. Trivial, but kept separate so the guard logic is
// pinned by a unit test independent of any database I/O.
export function decideEnsureAction(targetExists: boolean): EnsureAction {
  return targetExists ? 'skip' : 'create';
}

type Logger = (message: string) => void;

const defaultLog: Logger = (message) => {
  // eslint-disable-next-line no-console
  console.info(`[ensureDatabase] ${message}`);
};

// A pg error carrying SQLSTATE 42P04 (duplicate_database): another boot created
// the database between our pg_database check and our CREATE. Benign, so we log
// and continue rather than fail the boot.
function isDuplicateDatabaseError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '42P04'
  );
}

// Ensure the DATABASE_URL target database exists, creating it via the server's
// `postgres` maintenance database if absent. Runs BEFORE migrations. A clean
// no-op in stub mode. Throws on any non-benign failure so the container fails
// fast rather than proceeding to migrate a database that is not there.
export async function ensureDatabase(
  opts: { log?: Logger } = {},
): Promise<void> {
  const log = opts.log ?? defaultLog;

  if (!hasDatabase()) {
    log('DATABASE_URL not set: stub mode, skipping database ensure');
    return;
  }

  const plan = planDatabaseEnsure(config.database.url);
  if (plan === null) {
    log('DATABASE_URL has no target database in its path: skipping ensure');
    return;
  }

  // Connect to the maintenance database, NOT the target (which may not exist).
  // pgConnectionConfig on the /postgres URL gives identical SSL handling.
  const client = new pg.Client(pgConnectionConfig(plan.adminUrl));
  await client.connect();
  try {
    const existing = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [plan.target],
    );
    const targetExists = (existing.rowCount ?? existing.rows.length) > 0;

    if (decideEnsureAction(targetExists) === 'skip') {
      log(`database "${plan.target}" already present`);
      return;
    }

    // Absent: create it. CREATE DATABASE has no IF NOT EXISTS and cannot run in
    // a transaction, so the pg_database check above is the guard and a racing
    // 42P04 is caught below. The identifier is double-quoted (quotes doubled).
    const ident = plan.target.replace(/"/g, '""');
    log(`database "${plan.target}" absent: creating`);
    try {
      await client.query(`CREATE DATABASE "${ident}"`);
      log(`created database "${plan.target}"`);
    } catch (err) {
      if (isDuplicateDatabaseError(err)) {
        log(
          `database "${plan.target}" created concurrently (duplicate_database), continuing`,
        );
      } else {
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}
