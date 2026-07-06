# ADR-0004: Implement the standalone service in Rust/warp + Yew/WASM, mirroring the middleware's stack, as an external read-only consumer

- Status: Draft (Architect seat, 2026-07-05). This ADR is a human gate: it is pending Steve's (the operator's) sign-off, and no scaffolding begins until he flips it to Accepted.
- Deciders: Steve (operator), Architect seat.
- Companion: design.md, ADR-0001 (delivery vehicle: standalone read-only service), ADR-0002 (materialized health snapshot read-model).

## Context

ADR-0001 fixed that order health ships as a standalone read-only service in its own repo (`grundens-it/order-health`), and ADR-0002 fixed that it computes a periodic snapshot into its own datastore. What is still open, and what ADR-0001 explicitly deferred here, is the **implementation stack**: which language, web framework, and frontend this service is built in before Unit 0 scaffolds anything.

The shape of the service is now well understood from the design:

- A backend that reads the middleware's existing read-only HTTP endpoints (`dashboard.rs` activity/errors, `job-queue/health`, `back-sync/missed-shipments`, stuck-staging, pending-fulfillment) and NAV read-only, and serves its own read endpoints off the snapshot.
- A scheduled "health aggregator" (the snapshot writer of ADR-0002) that runs on a cadence, computes the two-layer model, and writes `order_health_snapshot` / `pipeline_health_snapshot` / `health_transition`.
- A frontend that is not a static chart page: the demo (`order-health-dashboard-demo.html`) fixes a dark-theme SPA with a pipeline-health strip, an order table with a DTC / wholesale / all channel filter, per-signal remediation modals, and an outage-replay interaction. It carries real client-side state.

One boundary from ADR-0001 and design.md section 0 governs every option below and must not be misread. **Reusing `dashboard.rs` means reading its endpoints as an external consumer and copying the read-view shape in this repo's own code. It never means editing, importing from, or otherwise coupling to the Symmetry-owned middleware.** The middleware is production code we do not own; this service adds no code, endpoints, migrations, or tables to it. Option A below leans on the middleware's *idioms*, not its *repo*.

## Decision

Build this service in **Rust with warp on the backend and Yew/WASM on the frontend**, mirroring the Symmetry middleware's stack, as a fully separate external consumer. The middleware's `dashboard.rs` read-view shape and its tokio-cron scheduled-writer idioms are copied into this repo's own code; nothing in the middleware is edited or imported. One language spans the read endpoints, the aggregator loop, and the frontend. The datastore engine is left to Unit 0 (see Consequences).

## Alternatives considered

### Alternative A: Mirror the middleware stack (Rust + warp backend, Yew/WASM frontend)

Stand up this service in the same stack the team already operates, as an external read-only consumer of the middleware's endpoints.

- Pros: the team already runs and maintains this exact stack, so there is no second toolchain to learn or support; the `dashboard.rs` read-view shape (the five-table merge, the activity/errors views) ports directly into this repo's own code as a starting template for the read endpoints; the ADR-0002 snapshot writer maps cleanly onto the middleware's existing tokio-cron scheduled-sync idiom, which is the pattern the team already reasons about for watermark-driven writers; one language covers backend, aggregator, and frontend, so verdict-logic types (the channel dimension, the three-verdict inventory-sync contract in design.md 5A.2) are shared, not re-declared across a language boundary.
- Cons: Yew/WASM iterates more slowly than a mainstream JS/React frontend, and the demo's richer interactions (remediation modals, outage replay) are more work to build in Yew than in React; the WASM build adds a compile-and-bundle step to the frontend loop; the Rust hiring/contribution pool is narrower than JS if the team ever grows this service out.

### Alternative B: Lighter single-service stack (Node or Python backend, static or React frontend)

Build the whole service in one mainstream scripting stack, optimizing for frontend iteration speed.

- Pros: faster UI iteration, which the demo's interaction-heavy frontend (modals, channel filter, replay) rewards; a larger contributor and hiring pool; the frontend can use React directly, matching the demo's component shape closely.
- Cons: introduces a second production toolchain into an org that today standardizes on the Rust middleware stack, which is a real long-term operational and maintenance cost (build, deploy, dependency, and on-call surface) for one service; the `dashboard.rs` read-view shape and the tokio-cron scheduled-writer idiom must be re-implemented from scratch rather than ported, so the "reuse the middleware's shape" advantage is lost exactly where it is most concrete (the aggregator and the read views); verdict-logic types are re-declared in a different language than the team's mental model of the sources.

### Alternative C: Hybrid (Rust + warp backend, lightweight JS/React frontend)

Keep the backend and aggregator in Rust (where the read-view and scheduler reuse is real) and build only the frontend in React (where iteration speed matters most).

- Pros: keeps the concrete backend reuse (read-view shape, tokio-cron writer, shared source access) while getting React's faster UI loop for the interaction-heavy demo surface; the read/write split is a clean HTTP boundary already.
- Cons: still a second toolchain, just scoped to the frontend, so it carries a lighter version of Option B's cost without Option A's single-language simplicity; two languages means the verdict/channel types are defined on the Rust side and mirrored (by hand or by a codegen step) on the JS side, a small but standing correctness seam. Worth reconsidering only if UI iteration speed becomes the binding constraint.

## Recommendation

Alternative A. The decisive factors are team familiarity (this is the stack the team already runs, and adding no second toolchain for a single service is the cheaper long-run posture) and concrete, not hand-wavy, reuse: the `dashboard.rs` read-view shape ports into this repo directly, and the ADR-0002 snapshot writer maps onto the tokio-cron idiom the team already uses for watermark-driven writers. One language across the read endpoints, the aggregator, and the frontend keeps the channel dimension and the three-verdict inventory-sync contract as shared types rather than re-declared ones.

The strongest argument for Option B (and, in a milder form, Option C) is frontend iteration speed on an interaction-heavy demo surface. That is a real cost of Yew/WASM and is acknowledged, but it is a one-service UI-velocity concern weighed against standing up and staffing a second org toolchain, and it does not outweigh the reuse and single-stack simplicity for v1. Option C stays the clean fallback if UI velocity later becomes the binding constraint; the read/write HTTP boundary is already there to swap the frontend without touching the aggregator.

## Consequences

- Hosting and build (Option A as decided): a single Rust toolchain covers the whole service. The frontend is a Yew/WASM bundle, so the build produces a compiled WASM artifact plus its JS glue, served as static assets alongside the warp read endpoints. There is one CI toolchain, one dependency ecosystem, and one on-call mental model, matching what the team already operates for the middleware.
- Reuse is by copy, not coupling: the read-view shape and the scheduled-writer idiom are lifted from the middleware's *patterns* into this repo's own code. This service still consumes the middleware only over its existing read-only HTTP endpoints and reads NAV read-only, exactly as ADR-0001 and ADR-0002 require. Zero changes to the Symmetry middleware.
- Datastore engine is left to Unit 0. This ADR fixes the language and framework, not the storage engine. Unit 0 chooses among reusing whatever the middleware uses (SQLite, per the design's references to middleware SQLite tables), Postgres, or SQLite for this service's own snapshot store. Whichever is chosen, the snapshot tables (`order_health_snapshot`, `pipeline_health_snapshot`, `health_transition`) live in this service's own datastore, and the channel dimension stays a first-class column so wholesale is never mis-graded as an orphan (design.md section 4, ADR-0002).
- The channel dimension (DTC vs wholesale) is modeled once, in Rust, as a shared type across the aggregator, the read endpoints, and the Yew frontend's channel filter.
- If Steve instead picks Option B: the org takes on a second production toolchain (Node or Python) for this one service, the `dashboard.rs` read-view shape and the tokio-cron writer idiom are re-implemented rather than ported, and the verdict/channel types are re-declared in the frontend's language. In exchange, the interaction-heavy frontend (remediation modals, outage replay, channel filter) iterates faster in React. If Steve picks Option C, the backend consequences above hold unchanged and only the frontend moves to React, adding a Rust-to-JS type seam at the HTTP boundary.
- This ADR is a human gate. No repo scaffolding, dependency selection, or Unit 0 work begins until Steve flips the status to Accepted.

## References

- design.md sections 0 (project boundary), 5A.2 (the three-verdict read-model contract), 6 (proposed architecture), and the "reuse dashboard.rs means read as an external consumer" note.
- ADR-0001 (standalone read-only service; the deferred stack sub-decision captured here).
- ADR-0002 (materialized snapshot; the snapshot writer this stack must host, and the datastore left to Unit 0).
- `demo/order-health-dashboard-demo.html` (the dark-theme SPA, pipeline strip, channel filter, remediation modals, and outage replay that set the frontend's interaction bar), read for frontend implications only.
- The middleware's `dashboard.rs` read views and its tokio-cron scheduled writers, consumed and copied in shape, never modified.
