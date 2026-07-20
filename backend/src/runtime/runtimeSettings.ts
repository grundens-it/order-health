// Runtime settings for the remediation arm state + kill switch (issue #97).
//
// The arm state and kill switch move from env-only to a runtime_settings table
// with ENV FALLBACK: each flag resolves as (runtime_settings row if present) ELSE
// (the existing env config default). REMEDIATION_LIVE_ENABLED / REMEDIATION_KILL_SWITCH
// stay the seed default, so with no row present behaviour is byte-for-byte
// unchanged (still DISARMED by default). Every admin write upserts the row AND
// appends a runtime_settings_audit entry (who / when / what).
//
// DB-optional: when no DATABASE_URL is configured (dev / CI / stub mode) there is
// no table to read, so the resolvers return the env config default and the writers
// report that persistence is unavailable. This keeps the existing remediation
// tests (which run without a DB) identical to before.
import type { FlagSource, RemediationArmState } from '@order-health/shared';
import { config, hasDatabase } from '../config';
import { getPool, query } from '../db/pool';

// runtime_settings keys (stable string keys, one row each).
export const KEY_LIVE_ENABLED = 'remediation_live_enabled';
export const KEY_KILL_SWITCH = 'remediation_kill_switch';

// A stored setting value is 'true' / 'false'. Parse leniently (1 / true).
export function parseBoolSetting(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'true' || v === '1';
}

// PURE resolution: a stored row value (or null/undefined when no row) ELSE the env
// default. This is the unit-tested core of the env-fallback precedence.
export function resolveFlag(rowValue: string | null | undefined, envDefault: boolean): boolean {
  if (rowValue === null || rowValue === undefined) return envDefault;
  return parseBoolSetting(rowValue);
}

interface SettingRow {
  value: string;
  updated_at: string;
  updated_by: string | null;
}

// Read one runtime_settings row, or null when absent / no DB.
async function getSettingRow(key: string): Promise<SettingRow | null> {
  if (!hasDatabase() || getPool() === null) return null;
  const rows = await query<SettingRow>(
    `SELECT value, updated_at, updated_by FROM runtime_settings WHERE key = $1`,
    [key],
  );
  return rows[0] ?? null;
}

// The resolved flags the remediation client + trigger route read. In stub mode
// (no DB) this is exactly the env config, so armed/disarmed behaviour is unchanged.
export async function resolveRemediationFlags(): Promise<{
  remediationLiveEnabled: boolean;
  killSwitch: boolean;
}> {
  if (!hasDatabase() || getPool() === null) {
    return {
      remediationLiveEnabled: config.remediation.liveEnabled,
      killSwitch: config.remediation.killSwitch,
    };
  }
  const [liveRow, killRow] = await Promise.all([
    getSettingRow(KEY_LIVE_ENABLED),
    getSettingRow(KEY_KILL_SWITCH),
  ]);
  return {
    remediationLiveEnabled: resolveFlag(liveRow?.value, config.remediation.liveEnabled),
    killSwitch: resolveFlag(killRow?.value, config.remediation.killSwitch),
  };
}

// The full resolved arm state for the admin GET, with per-flag source + the last
// admin who changed a row (env-only => null / null).
export async function getArmState(): Promise<RemediationArmState> {
  const liveRow = await getSettingRow(KEY_LIVE_ENABLED);
  const killRow = await getSettingRow(KEY_KILL_SWITCH);
  const remediationLiveEnabled = resolveFlag(liveRow?.value, config.remediation.liveEnabled);
  const killSwitch = resolveFlag(killRow?.value, config.remediation.killSwitch);
  const liveEnabledSource: FlagSource = liveRow ? 'runtime_settings' : 'env_default';
  const killSwitchSource: FlagSource = killRow ? 'runtime_settings' : 'env_default';

  // The most-recent row wins for the "last changed by / at" summary line.
  const rows = [liveRow, killRow].filter((r): r is SettingRow => r !== null);
  rows.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  const newest = rows[0] ?? null;

  return {
    remediationLiveEnabled,
    killSwitch,
    armed: remediationLiveEnabled && !killSwitch,
    liveEnabledSource,
    killSwitchSource,
    updatedBy: newest?.updated_by ?? null,
    updatedAt: newest?.updated_at ?? null,
  };
}

// The human "what changed" label recorded in the audit + surfaced to the operator.
function auditAction(key: string, value: boolean): string {
  if (key === KEY_LIVE_ENABLED) return value ? 'armed' : 'disarmed';
  if (key === KEY_KILL_SWITCH) return value ? 'kill-on' : 'kill-off';
  return value ? 'on' : 'off';
}

// Upsert a runtime_settings flag AND append the audit row, both inside one
// transaction (issue #97). Requires a DB: throws in stub mode so the admin route
// can return a clear 503 rather than silently no-op a security-relevant write.
export async function setRemediationFlag(
  key: string,
  value: boolean,
  actor: string,
  nowIso: string,
): Promise<void> {
  const pool = getPool();
  if (!hasDatabase() || pool === null) {
    throw new Error('runtime settings require a database (DATABASE_URL is not configured)');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO runtime_settings (key, value, updated_at, updated_by)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [key, String(value), nowIso, actor],
    );
    await client.query(
      `INSERT INTO runtime_settings_audit (key, value, action, actor, at)
         VALUES ($1, $2, $3, $4, $5)`,
      [key, String(value), auditAction(key, value), actor, nowIso],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
