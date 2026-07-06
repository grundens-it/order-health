// Lazily-constructed Postgres connection pool for THIS service's own datastore.
// The pool is created only when a DATABASE_URL is present; the scaffold
// typechecks and the API runs (on the stub layer) without a live database.
import pg from 'pg';
import { config, hasDatabase } from '../config';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool | null {
  if (!hasDatabase()) return null;
  if (pool === null) {
    pool = new pg.Pool({ connectionString: config.database.url });
  }
  return pool;
}

// Thin query helper. Returns rows typed by the caller. Read paths use this;
// the aggregator uses it for its snapshot writes into this service's own DB.
export async function query<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const p = getPool();
  if (p === null) {
    throw new Error('No DATABASE_URL configured: query() is unavailable in stub mode.');
  }
  const result = await p.query(text, params);
  return result.rows as T[];
}
