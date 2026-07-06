-- 0001_init.sql
-- Order Health Observability: initial snapshot schema (ADR-0002, design.md 4/5A).
--
-- This is THIS service's own datastore. None of these tables live in, or are
-- added to, the Symmetry-owned middleware. The health aggregator writes these
-- tables on a cadence; the read API serves from them. Every snapshot row carries
-- an as_of timestamp (the materialization time) so freshness is self-disclosing.
--
-- Read-only posture: the aggregator only READS the middleware endpoints and NAV.
-- The only writes in the whole system are the aggregator writing these snapshot
-- tables in this service's own Postgres database.

BEGIN;

-- Channel is a FIRST-CLASS dimension from the very first migration so that
-- wholesale (NAV-originated, correctly has no Shopify WebId) is never
-- mis-graded as an orphan DTC order. See design.md section 4.
CREATE TYPE channel AS ENUM ('dtc', 'wholesale');

-- Verdict is the RED / AMBER / GREEN health grade used everywhere. 'unknown'
-- covers a stage/pipe not yet evaluated (for example before a source is
-- provisioned). Encoded by shape as well as color in the UI (accessibility).
CREATE TYPE verdict AS ENUM ('green', 'amber', 'red', 'unknown');

-- Canonical lifecycle stage an order is currently sitting at. Stages differ by
-- channel: DTC runs the full chain; wholesale has no Shopify back-sync leg.
CREATE TYPE lifecycle_stage AS ENUM (
  'shopify_order',      -- DTC: Shopify order received
  'allocator_split',    -- DTC: warehouse-splitter allocation decision
  'nav_staging',        -- staged into NAV (Sales Header Staging)
  'nav_promotion',      -- promoted to a live NAV order
  'awaiting_ship',      -- promoted, awaiting 3PL shipment
  'nav_shipment',       -- NAV shipment exists (3PL shipped)
  'back_sync',          -- DTC only: fulfillmentCreate back to Shopify
  'complete'            -- terminal healthy state
);

-- =========================================================================
-- order_health_snapshot: per-order lifecycle verdict, both channels.
-- One row per order per materialization. The read API filters by channel.
-- =========================================================================
CREATE TABLE order_health_snapshot (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- as_of is the snapshot materialization time. Every health response echoes it.
  as_of               TIMESTAMPTZ     NOT NULL,

  -- Channel dimension, first-class (see note above). Wholesale rows simply have
  -- no Shopify leg to grade and must never be flagged as orphans for that.
  channel             channel         NOT NULL,

  -- Order identity. DTC correlates on the Shopify WebId carried on the NAV Sales
  -- Header; wholesale is keyed on the NAV order number and customer, with no
  -- WebId. Both keys are nullable because a given channel populates one side.
  nav_order_no        TEXT,           -- NAV Sales Header no. (both channels)
  shopify_order_id    TEXT,           -- Shopify order id / WebId (DTC only)
  shopify_order_name  TEXT,           -- human label, for example "#1024" (DTC)
  customer_ref        TEXT,           -- customer number / name for wholesale keying

  -- Current stage and the worst-stage rollup verdict for the order.
  current_stage       lifecycle_stage NOT NULL,
  order_verdict       verdict         NOT NULL DEFAULT 'unknown',

  -- Age of the oldest stuck hop for this order, in seconds. Drives the
  -- "oldest stuck age" rollup and the RED-after-SLO grading.
  oldest_stuck_age_s  INTEGER,

  -- True when a DTC order has an empty WebId (orphan candidate). Kept separate
  -- from channel so the orphan-vs-wholesale disambiguation (open question 9.1)
  -- can be resolved without conflating it with the channel dimension.
  is_orphan_suspect   BOOLEAN         NOT NULL DEFAULT FALSE,

  -- Free-form latched error / explainer for the worst stage, if any.
  note                TEXT,

  created_at          TIMESTAMPTZ     NOT NULL DEFAULT now()
);

COMMENT ON TABLE order_health_snapshot IS
  'Per-order lifecycle health, materialized on a cadence. Channel is first-class so wholesale is never mis-graded as an orphan.';

-- Serve the latest snapshot fast, filtered by channel.
CREATE INDEX idx_ohs_asof            ON order_health_snapshot (as_of DESC);
CREATE INDEX idx_ohs_channel_asof    ON order_health_snapshot (channel, as_of DESC);
CREATE INDEX idx_ohs_verdict         ON order_health_snapshot (order_verdict);

-- =========================================================================
-- pipeline_health_snapshot: per-pipe freshness / liveness verdict.
-- Keyed by pipe (for example 'inventory_sync', 'back_sync', 'price_sync',
-- 'nav_job_queue', 'shopify_webhook', 'allocator'). The inventory-sync row is
-- the reference three-verdict contract from design.md 5A.2.
-- =========================================================================
CREATE TABLE pipeline_health_snapshot (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  as_of                 TIMESTAMPTZ NOT NULL,   -- materialization time
  pipe                  TEXT        NOT NULL,   -- pipe key (see list above)

  -- Rollup verdict for the pipe = worst of its sub-verdicts.
  pipe_verdict          verdict     NOT NULL DEFAULT 'unknown',

  -- Freshness: is the data current. For inventory_sync this is the IABC
  -- watermark lag; generalized here to any pipe with a watermark.
  freshness_verdict     verdict     NOT NULL DEFAULT 'unknown',
  watermark_lag_s       INTEGER,               -- newest source entry minus watermark, seconds
  last_progress_at      TIMESTAMPTZ,           -- last completed walk / loop with forward progress

  -- Liveness: is the loop running (heartbeat), independent of freshness.
  -- Part 1 showed these two genuinely diverge (cron alive, data stale).
  liveness_verdict      verdict     NOT NULL DEFAULT 'unknown',
  heartbeat_at          TIMESTAMPTZ,           -- last time the watcher logged a poll
  heartbeat_age_s       INTEGER,

  -- Optional per-pipe detail bag (walk counts, dry-run divergence numbers,
  -- CU 50007/50009 state, etc.). Kept as JSONB so each Phase W pipe can carry
  -- its own shape without a migration; typed views live in shared/.
  detail                JSONB       NOT NULL DEFAULT '{}'::jsonb,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE pipeline_health_snapshot IS
  'Per-pipe freshness and liveness verdicts, materialized on a cadence. Inventory-sync row follows the three-verdict contract in design.md 5A.2.';

CREATE INDEX idx_phs_asof        ON pipeline_health_snapshot (as_of DESC);
CREATE INDEX idx_phs_pipe_asof   ON pipeline_health_snapshot (pipe, as_of DESC);

-- =========================================================================
-- health_transition: verdict-change audit for the future notifier (design.md 8).
-- The aggregator is the single evaluation point; every time a pipe or signal
-- changes verdict it appends a row here. A later notifier tails this table.
-- Remediation resolutions (design.md 5A.4) stamp resolved_at on the open row.
-- =========================================================================
CREATE TABLE health_transition (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- What transitioned: a pipe key or an order-level signal identifier.
  subject_kind   TEXT        NOT NULL,          -- 'pipe' | 'signal' | 'order'
  subject_key    TEXT        NOT NULL,          -- for example 'inventory_sync' or a NAV order no.

  from_verdict   verdict     NOT NULL,
  to_verdict     verdict     NOT NULL,

  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when the new verdict was first observed
  resolved_at    TIMESTAMPTZ,                          -- set when it returns to green / is remediated
  note           TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE health_transition IS
  'Append-only verdict-change audit. Single evaluation point for the v1 alerting hook; a future notifier tails this table.';

-- Fast lookup of currently-open (unresolved) transitions per subject.
CREATE INDEX idx_ht_open ON health_transition (subject_kind, subject_key)
  WHERE resolved_at IS NULL;

COMMIT;
