# ADR-0002: Assemble order health from a periodically materialized snapshot, not per-request fan-out

- Status: Draft (Architect seat, 2026-07-02). Flip to Accepted once the operator signs off.
- Deciders: Steve (operator), Architect seat.
- Companion: design.md, ADR-0001 (delivery vehicle: standalone read-only service).

## Context

The Order Health service (ADR-0001) shows a two-layer model: per-order lifecycle verdicts across both channels, and per-pipe freshness/liveness. Because this is a standalone project that cannot modify the Symmetry middleware, it assembles verdicts by reading external sources read-only: the middleware's existing read-only HTTP endpoints (`dashboard.rs` activity/errors, `job-queue/health`, `back-sync/missed-shipments`, stuck-staging, pending-fulfillment), Shopify, and NAV read-only for anything the middleware does not already expose. This is a genuine multi-source join with real logic (DTC `WebId` correlation, wholesale keyed on NAV order number, orphan disambiguation).

The question: **when is that join computed?** On every page load, or ahead of time into a stored snapshot the page reads. NAV access is read-only and NAV query load is a shared concern (the CU 50007 hang in part 1 shows NAV is sensitive to serialized load).

## Decision

Compute the two-layer model on a periodic schedule in the service's own "health aggregator" and write it to snapshot tables in **the service's own datastore** (`order_health_snapshot`, `pipeline_health_snapshot`, `health_transition`), not in the middleware. The Order Health endpoints serve from those tables. Page loads never fan out to NAV, Shopify, or the middleware.

## Alternatives considered

### Alternative A: Live per-request fan-out

Each page load queries Shopify, NAV, and SQLite live and computes verdicts on the fly.

- Pros: always current to the second; no snapshot schema, no writer, no staleness window; simplest data model.
- Cons: every viewer, and every auto-refresh, multiplies NAV and Shopify query load; NAV is the exact resource part 1 showed is sensitive to serialized load; Shopify Admin API is rate-limited, so a leadership glance and an ops refresh compete for the same budget; page latency tracks the slowest of three systems; and there is no natural point to detect a GREEN -> RED transition for the alerting hook, because evaluation only happens when someone is looking.

### Alternative B: Periodically materialized snapshot

A scheduled aggregator computes verdicts and writes snapshot rows; endpoints read the snapshot.

- Pros: NAV and Shopify load is bounded and constant (one aggregator cadence) regardless of how many viewers or refreshes; page loads are fast and hit only local SQLite; the aggregator is the single evaluation point, so it can emit `health_transition` rows for the future notifier (design.md section 8) without a second engine; consistent with the existing cron/watermark model the middleware already uses everywhere; a future BI tool (ADR-0001 Alternative C) could read the same snapshot.
- Cons: introduces a staleness window equal to the aggregator cadence; adds schema and a writer; freshness signals must show "as of" timestamps so operators are not misled by a stale snapshot (mitigated: the pipeline-health layer literally measures freshness, so the snapshot age is itself displayed).

### Alternative C: Hybrid (snapshot for the table, live for a single drilled-in order)

Serve the bulk view from the snapshot; when an operator opens one order, fan out live for just that order.

- Pros: fast bulk view plus to-the-second detail on the one order in focus; live load is one order, not the whole table.
- Cons: two code paths for the same verdict logic, a real correctness risk (the snapshot says AMBER, the drill-in says GREEN, and now the operator distrusts both); more to build and test. Attractive later, not for v1.

## Recommendation

Alternative B. It bounds NAV and Shopify load independent of viewer count, keeps the page fast, matches the middleware's existing scheduled-sync idiom, and is the only option that gives the alerting hook a real evaluation point. The staleness window is not just tolerable but self-disclosing, because the pipeline-health layer displays freshness and the snapshot's own "as of" time directly.

Set the initial aggregator cadence conservatively (proposed: 2 to 5 minutes for the order layer, aligned to the ~2h IABC cycle for the inventory freshness layer) and let Ops tune it. Alternative C's per-order live drill-in is a clean future addition once the single-path verdict logic is trusted; deferring it avoids shipping two verdict code paths on day one. Alternative A is rejected: it puts unbounded, viewer-driven load on the one system (NAV) that part 1 proved is load-sensitive.

## Consequences

- Snapshot tables in the service's own datastore: `order_health_snapshot` (per-order, with a channel column so wholesale is first-class and never mis-graded as orphan), `pipeline_health_snapshot` (per-pipe freshness/liveness), `health_transition` (verdict-change audit for the future notifier). None of these live in the middleware.
- A scheduled aggregator in the service, reading the sources in design.md section 4 (the middleware's read-only endpoints and NAV read-only) and consuming already-computed verdicts (the middleware's `job-queue/health`) rather than recomputing them.
- Every health response carries an "as of" timestamp; the UI shows snapshot age.
- DevOps seat: owns the service's datastore and migration, the aggregator scheduling, and the notifier that tails `health_transition`.
- QA seat: verdict-correctness tests run against seeded snapshot rows (no live NAV needed), plus a staleness test (stop the aggregator, assert the age signal goes RED).
- Open dependency: the NAV codeunit instrumentation schema (design.md open question 2) must be confirmed before the aggregator can read it; until then the aggregator ships without that source and adds it additively.

## References

- design.md sections 3, 4, 5, 8, 9 and the Project boundary note.
- ADR-0001.
- The middleware's read-only endpoints, consumed not modified: `dashboard.rs` (read views), `nav/inventory_sync.rs` (watermark/heartbeat state, read via its status endpoint or NAV directly), `nav/job_queue_health.rs` (a verdict to consume, not recompute).
