# ADR-0004: Implement the standalone service in Node + TypeScript (backend) and React + TypeScript (frontend), a lighter stack decoupled from the middleware's toolchain

- Status: Accepted (operator sign-off: Steve, 2026-07-06). The Architect seat drafted this ADR on 2026-07-05 recommending Option A (mirror the middleware stack). The operator selected Option B and accepts the second-toolchain cost as a permanent org posture. No scaffolding began until this flip.
- Deciders: Steve (operator, deciding vote), Architect seat (drafted the recommendation).
- Companion: design.md, ADR-0001 (delivery vehicle: standalone read-only service), ADR-0002 (materialized health snapshot read-model).

## Context

ADR-0001 fixed that order health ships as a standalone read-only service in its own repo (`grundens-it/order-health`), and ADR-0002 fixed that it computes a periodic snapshot into its own datastore. What was still open, and what ADR-0001 explicitly deferred here, is the **implementation stack**: which language, web framework, and frontend this service is built in before Unit 0 scaffolds anything.

The shape of the service is now well understood from the design:

- A backend that reads the middleware's existing read-only HTTP endpoints (`dashboard.rs` activity/errors, `job-queue/health`, `back-sync/missed-shipments`, stuck-staging, pending-fulfillment) and NAV read-only, and serves its own read endpoints off the snapshot.
- A scheduled "health aggregator" (the snapshot writer of ADR-0002) that runs on a cadence, computes the two-layer model, and writes `order_health_snapshot` / `pipeline_health_snapshot` / `health_transition`.
- A frontend that is not a static chart page: the demo (`order-health-dashboard-demo.html`) fixes a dark-theme SPA with a pipeline-health strip, an order table with a DTC / wholesale / all channel filter, per-signal remediation modals, and an outage-replay interaction. It carries real client-side state.

One boundary from ADR-0001 and design.md section 0 governs every option below and must not be misread. **Reusing `dashboard.rs` means reading its endpoints as an external consumer and copying the read-view shape in this repo's own code. It never means editing, importing from, or otherwise coupling to the Symmetry-owned middleware.** The middleware is production code we do not own; this service adds no code, endpoints, migrations, or tables to it. This holds under every option below: the chosen stack changes nothing about the read-only, no-mutation boundary.

## Decision

Build this service in **Node.js with TypeScript on the backend and React with TypeScript on the frontend**, a lighter stack than the middleware's, optimizing for iteration speed on the interaction-heavy dashboard surface. TypeScript spans the read endpoints, the aggregator loop, and the frontend, so the verdict-logic types (the channel dimension, the three-verdict inventory-sync contract in design.md 5A.2) are shared types across backend and frontend rather than re-declared across a language boundary. The `dashboard.rs` read-view shape and the middleware's scheduled-writer idiom are re-implemented in TypeScript (a scheduled aggregator on a cadence), consumed only over the middleware's existing read-only HTTP endpoints. The datastore engine is left to Unit 0 (see Consequences).

Concrete realization for Unit 0: a Node + TypeScript backend (Fastify or an equivalently minimal HTTP framework), a React + TypeScript frontend (Vite build, dark theme per the demo), and a shared TypeScript types module for the channel dimension, the per-pipe verdicts, and the `as_of` envelope. If the operator prefers Python for the backend, that is a within-Option-B swap: the frontend stays React/TypeScript and the shared-types benefit narrows to the frontend only.

## Alternatives considered

### Alternative A: Mirror the middleware stack (Rust + warp backend, Yew/WASM frontend)

Stand up this service in the same stack the team already operates, as an external read-only consumer of the middleware's endpoints.

- Pros: the team already runs and maintains this exact stack, so there is no second toolchain to learn or support; the `dashboard.rs` read-view shape (the five-table merge, the activity/errors views) ports directly into this repo's own code as a starting template for the read endpoints; the ADR-0002 snapshot writer maps cleanly onto the middleware's existing tokio-cron scheduled-sync idiom, which is the pattern the team already reasons about for watermark-driven writers; one language covers backend, aggregator, and frontend, so verdict-logic types (the channel dimension, the three-verdict inventory-sync contract in design.md 5A.2) are shared, not re-declared across a language boundary.
- Cons: Yew/WASM iterates more slowly than a mainstream JS/React frontend, and the demo's richer interactions (remediation modals, outage replay) are more work to build in Yew than in React; the WASM build adds a compile-and-bundle step to the frontend loop; the Rust hiring/contribution pool is narrower than JS if the team ever grows this service out.

### Alternative B: Lighter single-language stack (Node + TypeScript backend, React + TypeScript frontend) [SELECTED]

Build the whole service in one mainstream toolchain, optimizing for frontend iteration speed and a broad contributor pool.

- Pros: faster UI iteration, which the demo's interaction-heavy frontend (modals, channel filter, replay) rewards; a larger contributor and hiring pool; the frontend uses React directly, matching the demo's component shape closely; with TypeScript on both sides, the "one language, shared verdict/channel types" benefit that motivated Option A is largely recovered on a mainstream toolchain.
- Cons: introduces a second production toolchain into an org that today standardizes on the Rust middleware stack, which is a real long-term operational and maintenance cost (build, deploy, dependency, and on-call surface) for one service; the `dashboard.rs` read-view shape and the scheduled-writer idiom are re-implemented in TypeScript rather than ported from the team's existing Rust, so the port is by pattern, not by code.

### Alternative C: Hybrid (Rust + warp backend, React frontend)

Keep the backend and aggregator in Rust (where the middleware read-view and scheduler reuse is real) and build only the frontend in React (where iteration speed matters most).

- Pros: keeps the concrete backend reuse (read-view shape, scheduled writer, shared source access) while getting React's faster UI loop for the interaction-heavy demo surface; the read/write split is a clean HTTP boundary already.
- Cons: still a second toolchain, scoped to the frontend, so it carries a lighter version of Option B's cost without Option A's single-language simplicity; two languages means the verdict/channel types are defined on the Rust side and mirrored (by hand or by a codegen step) on the JS side, a small but standing correctness seam.

## Recommendation and decision record

The Architect draft recommended **Option A** on two grounds: no second toolchain for a single service, and concrete reuse of the middleware's read-view and scheduled-writer idioms. The strongest counter, and the one the operator weighed as decisive, is frontend iteration speed and contributor breadth: the dashboard is an interaction-heavy SPA (pipeline strip, channel filter, remediation modals, outage replay), and that surface iterates faster in React with a broader pool than in Yew/WASM.

The operator selected **Option B** and accepts the second-toolchain cost as a permanent org posture, not a v1 convenience. Realizing Option B in TypeScript on both sides recovers most of Option A's shared-types benefit (the channel dimension and the three-verdict contract are shared TypeScript types), so the main thing given up versus A is the direct code-level port of the middleware's Rust read-view and scheduler; those are re-implemented by pattern in TypeScript instead. This is recorded as an accepted trade, not an open question.

## Consequences

- Hosting and build (Option B as decided): a single Node + TypeScript toolchain covers the backend, the aggregator, and (with React + Vite) the frontend. The build produces a static frontend bundle served alongside the backend's read endpoints. One CI toolchain and one dependency ecosystem, distinct from the middleware's Rust toolchain, which the org now maintains as a standing second stack.
- Reuse is by pattern, not by code and not by coupling: the `dashboard.rs` read-view shape and the scheduled-writer idiom are re-implemented in TypeScript. This service still consumes the middleware only over its existing read-only HTTP endpoints and reads NAV read-only, exactly as ADR-0001 and ADR-0002 require. Zero changes to the Symmetry middleware.
- Datastore engine is left to Unit 0. This ADR fixes the language and framework, not the storage engine. Unit 0 chooses among Postgres (recommended for a service that owns a real snapshot store plus a `health_transition` audit table and freshness queries) and SQLite (lighter to stand up locally, matching the design's references to middleware SQLite). Whichever is chosen, the snapshot tables (`order_health_snapshot`, `pipeline_health_snapshot`, `health_transition`) live in this service's own datastore, and the channel dimension stays a first-class column so wholesale is never mis-graded as an orphan (design.md section 4, ADR-0002).
- The channel dimension (DTC vs wholesale) is modeled once, as a shared TypeScript type, across the aggregator, the read endpoints, and the React frontend's channel filter.
- Node-vs-Python is a within-Option-B choice. The default realization is Node + TypeScript backend so the shared-types benefit spans backend and frontend. If the operator later prefers a Python backend, the frontend stays React/TypeScript and the shared types narrow to the frontend, with a Python-to-TypeScript contract seam at the HTTP boundary.
- This ADR is now Accepted. Unit 0 scaffolding proceeds on the Option B stack. The DevOps provisioning gate (read-only NAV path, middleware endpoint base URL and auth) still stands before the aggregator runs against real sources.

## References

- design.md sections 0 (project boundary), 5A.2 (the three-verdict read-model contract), 6 (proposed architecture), and the "reuse dashboard.rs means read as an external consumer" note.
- ADR-0001 (standalone read-only service; the deferred stack sub-decision captured here).
- ADR-0002 (materialized snapshot; the snapshot writer this stack must host, and the datastore left to Unit 0).
- `demo/order-health-dashboard-demo.html` (the dark-theme SPA, pipeline strip, channel filter, remediation modals, and outage replay that set the frontend's interaction bar), read for frontend implications only.
- The middleware's `dashboard.rs` read views and its scheduled writers, consumed over read-only HTTP and re-implemented in shape, never modified.
