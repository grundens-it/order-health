# ADR-0001: Deliver order health observability as a standalone read-only service, not an in-app tab in the Symmetry-owned middleware

- Status: Draft (Architect seat, 2026-07-02; revised 2026-07-05 after the ownership constraint was made explicit). Flip to Accepted once the operator signs off.
- Deciders: Steve (operator), Architect seat.
- Companion: design.md (the order health model), ADR-0002 (the read-model).

## Context

Order and inventory flow crosses three systems (Shopify, the Symmetry middleware, NAV 18) and two channels (DTC and wholesale). Today the observability is scattered across the middleware's per-pipeline tabs and a NAV SQL console, plus NAV-side codeunit instrumentation whose UI is not built for observability and does not connect the Shopify side. Investigations part 1 showed the cost: a stalled inventory-sync watcher and a 7,245-row dry-run divergence were only found by hand.

The decision is **where the unified order health dashboard lives**. One hard constraint dominates it:

- **The warehouse-splitter middleware is production code owned by Symmetry Commerce.** This dashboard is a separate Grundens project. It cannot add code, endpoints, migrations, or tables to the middleware, and it must not couple its release cycle to Symmetry's.
- NAV access is read-only.
- The middleware already exposes read-only observability HTTP endpoints (`dashboard.rs`: activity, errors, orders-today; plus `job-queue/health`, `back-sync/missed-shipments`, stuck-staging, pending-fulfillment).
- Audiences: Ops operators and a Leadership rollup.

## Decision

Build order health as a **standalone read-only observability service** in its own repo (`grundens-it/order-health`). It consumes the middleware's existing read-only HTTP endpoints and NAV read-only, materializes its own health snapshot in its own datastore, and serves its own UI. It adds nothing to the Symmetry middleware.

## Alternatives considered

### Alternative A: New tab inside the middleware's in-app Yew/WASM dashboard

Extend the middleware SPA and `dashboard.rs`.

- Pros: reuses the existing read-view pattern; one deploy artifact; already iframed into Shopify Admin.
- Cons, and this is now disqualifying: **it requires modifying Symmetry's production repo.** We do not own that code, cannot merge into it on our cadence, and would couple this dashboard's every change to Symmetry's release and review process. Ownership and release-coupling preclude it regardless of its technical merits.

### Alternative B: Standalone read-only observability service (own repo)

A separate service that reads the middleware's existing read-only endpoints and NAV read-only, computes and stores its own snapshot, and serves its own two-layer UI.

- Pros: respects the ownership boundary completely (zero changes to Symmetry's code); ships and deploys on Grundens' own cadence; owns its snapshot store so it has a real server-side evaluation point for the alerting hook; can still deep-link into the middleware's existing tabs and SQL console. The order-lifecycle join and channel logic is application logic this service owns.
- Cons: new repo, hosting, and auth surface to stand up and secure; a data path to NAV read-only and to the middleware's read endpoints must be provisioned; where a needed signal is not already exposed by the middleware, it must be read from NAV directly or (a gated ask) Symmetry exposes a new read-only endpoint.

### Alternative C: External BI tool (Grafana / Metabase) over the service's snapshot

- Pros: mature charting and built-in alerting.
- Cons: the order-lifecycle join (Shopify + NAV, DTC vs wholesale, orphan disambiguation) is real application logic, not a SQL panel, so a materialized model must be built to feed it anyway; the demo's remediation runbook and outage-replay interactions are not a BI-panel shape; adds a second operational system. Revisit only if analytics needs outgrow the custom UI. ADR-0002's snapshot is deliberately built so a BI tool could read it later.

## Recommendation

Alternative B. The ownership constraint removes A from contention: we cannot and should not edit Symmetry's production middleware to host a Grundens dashboard. B respects that boundary cleanly, keeps the dashboard on Grundens' own release cadence, and preserves the server-side evaluation point the alerting hook needs. C stays a later option for analytics, reading the same snapshot.

A thin Cowork artifact (like the demo) remains useful as a distributable leadership glance that reads this service's read endpoints, without becoming the system of record.

Deferred sub-decision: the service's implementation stack (mirror the middleware's Rust/warp + Yew for team familiarity, versus a lighter stack for faster UI iteration). Capture that in ADR-0004 before Unit 0 chooses.

## Consequences

- A new repo, service, hosting, and auth surface (DevOps seat), plus provisioning a read-only path to NAV and to the middleware's read endpoints.
- The snapshot store lives in this service's own datastore (ADR-0002), not in the middleware.
- **Zero changes to the Symmetry middleware.** Remediation actions (design.md 5A.4) invoke the middleware's existing authenticated endpoints (for example the recovery sweep already in `recovery.rs`) or documented ops runbooks; they do not add endpoints to the middleware.
- Coordination gate: for any signal the middleware does not already expose read-only (for example a watcher-heartbeat field), read it from NAV directly where possible; only if unavoidable, raise a gated request for Symmetry to add a read-only endpoint. Do not assume a middleware change.
- UX seat: owns the standalone UI, the leadership strip, and the non-color-only verdict encoding.
- BA seat: the open questions in design.md section 9 (orphan vs wholesale, SLO thresholds, leadership metric set) gate acceptance criteria.
- Revisit trigger: if analytics or alerting needs outgrow the custom UI, reconsider C over the same snapshot.

## References

- design.md sections 1, 2, 6, 8 and the Project boundary note.
- The middleware's read-only endpoints in `dashboard.rs` and `nav/*` (consumed, not modified).
- `documentation/GRUNDENS_INTEGRATION_MAP.md` (read-only reference).
- ADR-0002 (read-model), ADR-0004 (stack, to be drafted).
