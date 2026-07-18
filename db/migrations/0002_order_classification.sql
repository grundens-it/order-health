-- 0002_order_classification.sql
-- Round 3 (Unit 1): carry the FS-aware awaiting_ship classification and its
-- supporting numbers on the order snapshot, so the read API and the "why" UI can
-- explain WHY an order is red/amber (fs_floor_at_zero vs backorder vs 3PL vs
-- return). Additive, on THIS service's own snapshot table (no middleware / NAV /
-- Shopify write). Idempotent so a re-run is safe.

BEGIN;

ALTER TABLE order_health_snapshot
  ADD COLUMN IF NOT EXISTS classification text;

-- The full AwaitingShipDetail (classification, age, FS available, NAV warehouse
-- on-hand, sample SKU, the human "why") as JSONB, mirroring pipeline_health's detail.
ALTER TABLE order_health_snapshot
  ADD COLUMN IF NOT EXISTS awaiting_ship_detail jsonb;

COMMIT;
