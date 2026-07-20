-- 0003_runtime_settings.sql
-- Issue #97: move the remediation arm state + kill switch from env-only to a
-- runtime_settings table with ENV FALLBACK. A flag resolves as (row if present)
-- ELSE (env config default), so with no row the behaviour is unchanged (still
-- DISARMED by default). Every admin write upserts the row AND appends an audit
-- entry (who / when / what). Both tables are on THIS service's own datastore; no
-- middleware / NAV / Shopify write. Idempotent (CREATE TABLE IF NOT EXISTS) so
-- migrate-on-boot re-applies it safely.

BEGIN;

-- One row per runtime flag. value is 'true' / 'false' (text; the resolver parses).
CREATE TABLE IF NOT EXISTS runtime_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- Append-only audit of every arm/disarm / kill-switch change: who did it, when,
-- and what (armed / disarmed / kill-on / kill-off). Never updated in place.
CREATE TABLE IF NOT EXISTS runtime_settings_audit (
  id     bigserial PRIMARY KEY,
  key    text NOT NULL,
  value  text NOT NULL,
  action text NOT NULL,
  actor  text NOT NULL,
  at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_settings_audit_at_idx
  ON runtime_settings_audit (at DESC);

COMMIT;
