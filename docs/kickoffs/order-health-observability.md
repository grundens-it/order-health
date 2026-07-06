# Kickoff: Order Health Observability dashboard (full build)

> Lives in this repo (`grundens-it/order-health`) at `docs/kickoffs/order-health-observability.md`. Commit on a clean branch off main (worktree or GitHub API), then run the paste-ready `/goal` at the bottom. Self-contained: a fresh Claude Code session can run it with no prior chat.
> Shape: plan-first. The design is settled (see reading order); this round sequences and builds it.
> Origin: Cowork design round (design.md, ADR-0001, ADR-0002) plus an interactive dark-themed HTML demo that proved out the two-layer model and the remediation runbook.

## Project boundary (the most important thing to get right)

The Order Health dashboard is its **own standalone project in this repo**. It is **separate from** the Symmetry-owned warehouse-splitter middleware and **does not modify it**:

- The middleware is production code owned by Symmetry Commerce. We do not add code, endpoints, migrations, or tables to it, and we do not couple to its release cycle.
- This dashboard reads the middleware's **existing** read-only HTTP endpoints and NAV **read-only** as external data sources.
- The health aggregator and the snapshot store live in **this** service's own datastore, never in the middleware.
- Remediation actions call the middleware's **existing** authenticated endpoints (for example the recovery sweep already in the middleware's `recovery.rs`) or documented ops runbooks. They add no mutation path to the middleware.
- Where a needed signal is not already exposed read-only by the middleware, read it from NAV directly. Only if that is impossible, raise a gated request for Symmetry to expose a read-only endpoint. Never assume a middleware change.

When the design docs say "reuse `dashboard.rs`," they mean read its endpoints as an external consumer and copy its read-view shape in this repo's own code, not edit the middleware.

## Goal

Build the Order Health Observability dashboard: one surface that shows, at a glance, whether order and inventory flow across DTC and wholesale is healthy right now, and if not, which order or which pipe is unhealthy and what tool fixes it. Two layers on one page: a per-order lifecycle table (Shopify to split to NAV staging to promotion to 3PL ship to back-sync) and a pipeline-health strip (freshness and liveness per cron), over a periodically materialized snapshot in this service's own store, with an operator-triggered remediation runbook on each red signal.

## Reading order (read before writing anything)

1. `docs/architecture/design.md`, starting with section 0 (Project boundary) and 5A (Inventory Sync Monitor, the reference subsystem every other pipe copies), then 1 to 5 and 6 to 11.
2. `docs/architecture/adr/ADR-0001-order-health-delivery-vehicle.md` (standalone read-only service) and `ADR-0002-order-health-read-model.md` (materialized snapshot in this service's own store).
3. The HTML demo at `demo/order-health-dashboard-demo.html` as the visual and interaction spec: leadership rollup, pipeline strip, order table with channel dimension, error-to-remediation modals, outage replay, dark theme.

## Decision to settle first (gate before Unit 0 builds)

Draft `ADR-0004: service implementation stack` and get Steve's sign-off. Options with a recommendation:

- Option A (recommended): mirror the middleware's stack (Rust + warp backend, Yew/WASM frontend) for team familiarity and so the read-view and tokio-cron idioms port directly.
- Option B: a lighter stack (for example a single service in Node or Python with a static or React frontend) for faster UI iteration, accepting a second toolchain in the org.

Do not scaffold Unit 0 until the stack is chosen.

## Locked-in constraints (do not re-litigate)

- Delivery vehicle is a standalone read-only service (ADR-0001). The in-app-tab option is precluded by Symmetry ownership; do not re-open it.
- Read-model is the materialized snapshot in this service's own store (ADR-0002).
- Channel dimension (DTC vs wholesale) is first-class in the snapshot schema from the first migration, so wholesale never mis-grades as an orphan.
- Read-only NAV; zero changes to the middleware; the middleware's Cloudflare WAF skip rule and staging boundary are external facts, not ours to change.
- No em dashes in any output.

## The work

Front-load a short foundation phase, then fan out the independent pipe monitors and panels to subagents, then converge. Fan-out is gated on Unit 0 landing first, because the pipes share this service's snapshot schema and aggregator loop.

### Phase F (foundation, sequential, one context, must land first)

- Unit 0: scaffold the standalone service (per the ADR-0004 stack; use `/init-repo` conventions if the repo is empty). Stand up this service's own datastore and the snapshot schema (`order_health_snapshot` with a `channel` column, `pipeline_health_snapshot` keyed by `pipe`, `health_transition` audit). Build the health-aggregator scaffold and the scheduled writer skeleton (conservative cadence: order layer 2 to 5 min, inventory layer aligned to the ~2h IABC cycle) that reads the middleware's read-only endpoints and NAV read-only. Provision the read-only access paths (NAV read-only, middleware endpoint base URL and auth) as config. Build the two-layer UI shell and route. Every health response carries an `as_of` timestamp. This unblocks all fan-out units.

### Phase W (fan-out wave, independent subagents, after Unit 0)

Each unit owns exactly one `pipeline_health_snapshot` row or panel and one source, so they do not collide. Build Unit 1 first even within the wave; it is the reference the others copy.

- Unit 1: Inventory Sync Monitor (the reference subsystem, design 5A). Three independent verdicts (watermark freshness, watcher liveness, push-outcome sanity), the dry-run divergence amber-capped and never auto-red, the three-card panel plus the recent-walks bar chart and table. Reads the middleware's inventory-sync status endpoint where exposed, and NAV read-only (IABC watermark, Job Queue Log) for the rest. This is the template.
- Unit 2: Back-sync monitor plus the missed-shipments panel (consume the middleware's `back-sync/missed-shipments` endpoint; NAV `GRUS$Sales Shipment Header` read-only for detail).
- Unit 3: NAV job-queue monitor (consume the middleware's `job-queue/health` verdict, do not recompute) plus the small price-sync and Shopify-webhook monitors (last-received per topic, subscription-removal signal).
- Unit 4: Allocator monitor plus the Warehouse Split decisions panel (middleware read endpoint if exposed, else NAV read-only over the allocation source).
- Unit 5: Order lifecycle table plus the channel dimension. Per-order stage compute for DTC (WebId correlation) and wholesale (NAV order no, no Shopify leg, the orphan-or-wholesale case). Blocked by BA open question 1 for the orphan grading only; ship the table with orphan grading behind a flag until resolved.
- Unit 6: Leadership rollup strip (headline verdicts: healthy / at risk / stuck, oldest stuck age, inventory-sync fresh yes/no).

### Phase C (convergence, sequential, after the wave)

- Unit 7: Remediation runbook layer plus `health_transition` wiring. Each red signal maps to a named, operator-triggered tool that calls the middleware's existing authenticated endpoint or a documented ops runbook (recovery sweep, unblock-and-repromote, atomic watcher restart, clear the hung CU 50007 job, reconcile audit). No new middleware endpoints. Records open and resolution events to `health_transition`. Stub the notifier that tails that table (design 8); do not build delivery.
- Unit 8: Integration and hardening. Verdict-correctness tests against seeded snapshot rows (no live NAV). The staleness simulation (starve the aggregator, assert the inventory pipe goes RED while CU 50007 still completes). Accessibility: verdicts encoded by shape as well as color. Dark theme parity with the demo. Wire `/grundens:visual-status`.

## Subagent dispatch rules

- Hand each Phase W unit a self-contained prompt: its scope, its one snapshot row or panel, its single source (which middleware read endpoint and/or NAV read query), the Unit 1 pattern to copy, and the exact output (a PR that closes its sub-issue with a distilled 1,000 to 2,000 token return, not a transcript).
- Do not pass a worker this session's history.
- Fan out only Phase W. Phase F and Phase C stay in one context with compaction; they are coupled.

## Issues

Open one umbrella issue "Order Health Observability dashboard" with sub-issues Unit 0 through Unit 8 in this repo's tracker. Every PR closes its sub-issue. The umbrella tracks the round.

## Gates (stop for the human)

- Before Unit 0: ADR-0004 stack decision signed off.
- DevOps: provisioning the read-only NAV path and the middleware endpoint access (base URL, auth) before the aggregator can run against real sources.
- BA open questions before the affected units: orphan-vs-wholesale disambiguation (blocks Unit 5 orphan signal), and the NAV codeunit instrumentation schema (blocks any unit that reads it; ship without that source and add it additively).
- UX sign-off on the panels and the leadership strip.
- Never merge to main. Open PRs; Steve merges.

## Deliverables

- One PR per unit, each closing its sub-issue, on feature branches per this repo's convention.
- `docs/architecture/` populated (design.md, ADR-0001, ADR-0002, ADR-0004).
- A round-state file at `docs/rounds/order-health.round.json` updated at each unit boundary, and a `/grundens:visual-status` refresh at the same boundary.

## Round discipline

Keep the main thread short. After each unit completes, write the round-state file and refresh `/grundens:visual-status` so the plan tree reflects live issue and PR state. Compact rather than re-read. Commit this brief on a clean branch off main via a worktree or the GitHub API, never on the live checkout's current branch.

---

/goal Build the Order Health Observability dashboard in grundens-it/order-health per docs/kickoffs/order-health-observability.md. It is a standalone read-only service (ADR-0001) with its own datastore and materialized snapshot (ADR-0002); it does NOT modify the Symmetry-owned middleware, and reads the middleware's existing read-only endpoints plus NAV read-only. First draft ADR-0004 (stack) and STOP for Steve's sign-off. Then open the umbrella issue plus sub-issues Unit 0 to Unit 8. Run Phase F (Unit 0: service scaffold, own snapshot schema, aggregator reading middleware read-only + NAV read-only, UI shell) in this context. Then fan out Phase W (Units 1 to 6, independent pipe monitors and panels, each a self-contained subagent with a distilled return, Unit 1 the inventory monitor first as the template) and run Phase C (Units 7 to 8, remediation runbook plus health_transition, then integration and hardening) in one context. Channel dimension first-class, read-only NAV, zero middleware changes, no em dashes. Every PR closes its sub-issue. After each unit, update docs/rounds/order-health.round.json and refresh /grundens:visual-status. Stop at the stack, DevOps-provisioning, BA, and UX gates; never merge to main.
