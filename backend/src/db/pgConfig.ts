// Shared Postgres client config for both the boot migration runner and the
// aggregator pool.
//
// Azure Database for PostgreSQL flexible server REQUIRES SSL. The newer
// pg-connection-string treats `sslmode=require` as `verify-full` (strict
// certificate verification), which fails from the slim container image against
// Azure and crashes the container on boot. So we strip the ssl-related query
// params from the URL (so the connection-string parser does not apply
// verify-full) and pass an explicit ssl object: connections are encrypted but
// not verify-full. Local dev (localhost, no sslmode) connects plaintext,
// unchanged.
import type pg from 'pg';

export function pgConnectionConfig(url: string): {
  connectionString: string;
  ssl?: pg.ClientConfig['ssl'];
} {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // Not a parseable URL: hand it back untouched (stub paths never reach here).
    return { connectionString: url };
  }

  const host = u.hostname.toLowerCase();
  const sslModeRequested = /(require|verify-ca|verify-full|prefer)/i.test(
    u.searchParams.get('sslmode') ?? '',
  );
  // SSL when the URL asks for it, or when the host is Azure (defensive). Local
  // dev without sslmode stays plaintext, so the local Docker/compose flow is
  // unaffected.
  const needSsl = sslModeRequested || /\.azure\.com$/i.test(host);

  // Remove ssl params so pg does not re-apply verify-full from the string.
  for (const k of ['sslmode', 'ssl', 'uselibpqcompat', 'sslrootcert']) {
    u.searchParams.delete(k);
  }

  const connectionString = u.toString();
  return needSsl
    ? { connectionString, ssl: { rejectUnauthorized: false } }
    : { connectionString };
}
