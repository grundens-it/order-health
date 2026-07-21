-- 0004_order_handoff.sql
-- Round 4: carry the defect-based handoff classification on the order snapshot. This
-- is what now drives order_verdict (ownership, not elapsed time), so the read API and
-- the order table can show WHOSE an order is ("With Holman", "Finance hold", "Handoff
-- failed") instead of an age-derived "Unhealthy". Additive, on THIS service's own
-- snapshot table (no middleware / NAV / Shopify write). Idempotent so a re-run is safe.

BEGIN;

-- The full OrderHandoffDetail (state, owner, reason, label) as JSONB, mirroring the
-- awaiting_ship_detail column added in 0002.
ALTER TABLE order_health_snapshot
  ADD COLUMN IF NOT EXISTS handoff jsonb;

COMMIT;
