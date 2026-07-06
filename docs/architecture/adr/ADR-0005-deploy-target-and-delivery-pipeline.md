# ADR-0005: Deploy the standalone service co-located on the internal network beside the middleware, because network line-of-sight to internal NAV and the middleware is the dominant constraint

- Status: Draft (Architect seat, 2026-07-06), **pending Steve's sign-off on the deploy target**. This is a stop-for-the-human gate: no CD pipeline is built until the operator picks the target. Flip to Accepted once the operator signs off.
- Deciders: Steve (operator, deciding vote), Architect seat (drafted the recommendation).
- Companion: design.md (project boundary and the internal-source facts), ADR-0001 (delivery vehicle: standalone read-only service), ADR-0004 (stack: Node + TypeScript backend, React + TypeScript frontend, Postgres snapshot store).

## Context

ADR-0001 fixed that order health ships as a standalone read-only service in its own repo (`grundens-it/order-health`). ADR-0004 fixed the stack: a Node + TypeScript backend (a Fastify read API plus a node-cron health aggregator), a React + TypeScript + Vite frontend, and a Postgres snapshot store this service owns. Unit 9 is separately adding a local Docker Compose stack and a CI (build and test) workflow. What is still open, and what this ADR decides, is the **deploy target** and the shape of the CD pipeline that lands the service there. This is a decision the operator gates, so this ADR recommends and does not settle.

One constraint dominates every option and must be the spine of the analysis, not a footnote: **network reachability**. This service is useless unless it can reach the two sources it materializes its snapshot from, and both are internal:

- The **Symmetry warehouse-splitter middleware's existing read-only HTTP endpoints** (`dashboard.rs` activity/errors, `job-queue/health`, `back-sync/missed-shipments`, stuck-staging, pending-fulfillment). The configured base URL is internal (`MIDDLEWARE_BASE_URL=https://middleware.internal.grundens.example`, with a read-only bearer token).
- **NAV 18 read-only**, over SQL (`NAV_HOST=nav-sql.internal.grundens.example`, port 1433, a read-only login), for the IABC watermark, watcher state, and the allocation and shipment detail the middleware endpoints do not expose.

Both hosts sit on the Grundens internal network. A deploy target therefore has to have network line-of-sight to those internal systems: same network, a VPN, or a secure tunnel/connector. This reachability requirement dominates convenience, low-ops appeal, and managed-platform polish. A target that is fast to stand up but cannot see NAV and the middleware does not clear the bar at all.

Facts that are fixed and external, and that this ADR does not change (design.md section 0 and section 8): the Cloudflare WAF skip rule for `/webhooks/shopify/` stays as-is (webhook subscription health is a signal this service reads, not a config it owns), and the Cthulhu / NAV staging-table boundary is unchanged (this service reads NAV read-only and adds no write path). This ADR decides only where the read-only observability service runs and how it is delivered there.

The other placement facts each option must answer: where Postgres lives (this service's own snapshot store, never in the middleware), how the read-only NAV and middleware credentials wire as secrets (`DATABASE_URL`, `MIDDLEWARE_BASE_URL` + `MIDDLEWARE_AUTH_TOKEN`, `NAV_HOST`/`NAV_USER`/`NAV_PASSWORD`), how the Vite static frontend bundle is served, and the CD shape (a GitHub Actions workflow that builds the images/bundle and deploys).

## Decision

**Recommended, pending the operator's sign-off:** deploy the service **co-located on the Grundens internal network beside the middleware** (Alternative A). A small VM or single container host on the same internal network runs the Docker Compose stack Unit 9 defines (Fastify read API plus the node-cron aggregator, the built Vite bundle served alongside the read API, and this service's own Postgres). Reachability to NAV read-only and the middleware's read-only endpoints is direct, over the internal network, with no tunnel in the path. CD is a GitHub Actions workflow that builds the backend image and the frontend bundle, publishes the artifact, and deploys onto that internal host.

This is the target the reachability constraint favors. It is presented for Steve to accept, not as a settled decision, and it is the one open question below that unblocks the CD work.

## Alternatives considered

### Alternative A: Co-located on the internal network beside the middleware [RECOMMENDED]

A small VM or single container host on the same internal network as the middleware and NAV, running the Unit 9 Docker Compose stack.

- Network path: direct. NAV read-only (port 1433) and the middleware's read-only endpoints are reachable on the internal network with no tunnel, VPN, or public exposure in the data path. This is the strongest possible answer to the dominant constraint.
- Postgres: this service's own Postgres runs on the same host (a container in the compose stack) or on a nearby managed internal instance. Either way the snapshot store stays on the internal side, close to the aggregator that writes it.
- Secrets: `DATABASE_URL`, `MIDDLEWARE_BASE_URL` + `MIDDLEWARE_AUTH_TOKEN`, and the `NAV_*` read-only credentials are provided to the host as environment/secret files (for example a host-managed `.env` the compose stack reads, or the internal secret store the middleware host already uses), never committed. The read-only posture of every source credential is unchanged.
- Frontend: the Vite build produces a static bundle served by the backend host alongside the read API (the ADR-0004 "static bundle served alongside the backend's read endpoints" shape), so there is one origin and no CORS or second-host concern.
- CD shape: GitHub Actions builds and tests (reusing the Unit 9 CI), builds the backend image and the frontend bundle, and deploys onto the internal host (a pull-and-restart of the compose stack, or a registry push the host pulls). The runner needs a path to the internal host (a self-hosted runner on the internal network, or a deploy step the internal host initiates); this is the main operational detail A introduces and it is smaller than a standing tunnel.
- Cost: a host to provision and patch on the internal network, and self-management of Postgres if it is not a nearby managed instance. This is the price of the direct reachability that the constraint makes non-negotiable.

### Alternative B: Cloud VM or container service with a VPN/tunnel back to the internal network

A more managed host in the cloud, reaching NAV and the middleware through a VPN or tunnel.

- Network path: reachability is real but indirect, through the tunnel. The tunnel is now a standing dependency and an operational surface: if it drops, the aggregator cannot read its sources and the snapshot goes stale, which is exactly the freshness failure this service exists to catch. It must be monitored and owned.
- Postgres: a managed cloud Postgres next to the compute, which is operationally nice, but the aggregator's reads still traverse the tunnel to reach NAV and the middleware.
- Secrets: the same variables, held in the cloud platform's secret store, plus the tunnel's own credentials/keys as an added secret to manage.
- Frontend: the Vite bundle is served by the cloud host alongside the read API, same single-origin shape as A.
- CD shape: a cleaner managed deploy from GitHub Actions (no self-hosted runner needed), which is the honest upside of B, but the CD story now also has to stand up and keep the tunnel healthy.
- Trade: more managed compute in exchange for a tunnel that is a new dependency in the hot path of the one thing this service does. The convenience is real; the tunnel cost is real and permanent.

### Alternative C: Managed container host (Fly.io / Render) with managed Postgres

A public managed platform with managed Postgres, minimal ops.

- Network path, and this is the disqualifying gap unless paired with a connector: a public managed host **cannot reach internal NAV or the middleware** on `*.internal.grundens.example`. It has no line-of-sight to the internal network out of the box. It is realistic only when paired with a tunnel or connector back to the internal network, at which point it collapses into a lower-control variant of B and carries B's tunnel dependency plus less network control than a VM Grundens owns.
- Postgres: managed Postgres is the genuine strength here and would serve the snapshot store well, but it does not help the aggregator reach its internal read sources, which is the binding constraint.
- Secrets: platform secret store for the same variables, plus the connector's credentials.
- Frontend: trivially served (a static site or alongside the app), the one place C is unambiguously easy.
- CD shape: the lowest-ops CD of any option (a Git push deploys), which is why it is tempting, but it does not answer reachability without the connector, so its low-ops appeal is mostly illusory for this service.

### Alternative D: Cloudflare (Workers / Pages)

Cloudflare Pages for the frontend, Workers for the backend.

- Network path: Pages is a good fit for the **static Vite frontend**. Workers is a poor fit for this backend: a long-lived node-cron aggregator and a persistent Postgres connection do not match the Workers execution model, which would need Hyperdrive plus an external Postgres, and would still face the same internal-reachability problem reaching NAV and the middleware. Workers cannot see `*.internal.grundens.example` without a Cloudflare Tunnel back to the internal network.
- Postgres: external managed Postgres via Hyperdrive, a further moving part, and still no line-of-sight to the internal read sources without a tunnel.
- Secrets: split across two Cloudflare products, plus the tunnel credentials.
- Frontend: Pages is a clean, cheap home for the static bundle and is the one strong half of this option.
- CD shape: two deploy targets (Pages for the frontend, the backend elsewhere) means a split pipeline and more moving parts. The realistic best case for D is a split: Pages for the frontend, the backend hosted under A or B. That adds a second origin (CORS, a second deploy) for a service whose backend still has to live on or tunnel into the internal network regardless.

## Recommendation

Alternative A. The reachability constraint decides this: the service must read internal NAV and the internal middleware, and co-location on the internal network is the only option that gives direct line-of-sight with no tunnel in the data path. B and C and the Workers half of D all reintroduce the same thing, a tunnel or connector back to the internal network, as a standing dependency in the hot path of the aggregator's reads, which is precisely the freshness/liveness surface this service is built to watch. Paying for a managed platform and then bolting a tunnel onto it to reach systems Grundens already owns network access to is the wrong trade for a single internal read-only service.

The honest counter is operational convenience: B and C offer more managed compute and a cleaner GitHub Actions deploy (no self-hosted runner), and C and Pages offer managed Postgres and trivial static hosting. Those are real, and if the operator weights low-ops managed infrastructure over direct reachability, B (a cloud VM with a well-owned, monitored tunnel) is the next-best target, with the tunnel accepted as a permanent monitored dependency. Cloudflare Pages remains a reasonable home for the static frontend under any option, but it does not change where the backend must live.

This is a recommendation for Steve to accept, not a settled decision. The CD pipeline is not built until the operator picks the target, because the target determines the runner topology (self-hosted internal runner for A, managed runner plus tunnel for B) and the secret store.

## Consequences

- Secrets management: the read-only NAV credentials (`NAV_HOST`, `NAV_USER`, `NAV_PASSWORD`, and the rest of the `NAV_*` set), the middleware read-only access (`MIDDLEWARE_BASE_URL` + `MIDDLEWARE_AUTH_TOKEN`), and `DATABASE_URL` are provisioned to the chosen host as environment/secret material and never committed (the repo ships only `.env.example`; the real `.env` stays gitignored). Under A they live in the internal host's secret/env store; under B/C/D they live in the platform secret store plus the tunnel's own credentials. Every source credential stays read-only, unchanged from ADR-0001, ADR-0004, and design.md section 0.
- The DevOps provisioning gate from ADR-0004 wires in here: the read-only NAV path and the middleware endpoint base URL and auth must be provisioned and reachable from the chosen target before `AGGREGATOR_ENABLED=true` is set and the node-cron writer runs against real sources. Until then the service runs the ADR-0004 stub mode (typechecks and serves empty, `as_of`-stamped snapshots). The deploy target choice is upstream of that gate: the gate can only be satisfied from a target that has line-of-sight to the internal sources.
- Postgres lands in this service's own datastore regardless of target (co-located container/instance under A, managed Postgres under B/C/D), never in the middleware. The channel dimension and the snapshot/`health_transition` tables from ADR-0002 and ADR-0004 are unaffected by placement.
- Zero changes to the Symmetry middleware and no new write path into NAV, under every option. The Cloudflare WAF skip rule and the NAV staging-table boundary stay external and untouched.
- **No CD is built until Steve picks the target.** This ADR is a human gate. The GitHub Actions CD workflow (build images/bundle, publish, deploy) is written only after sign-off, because the target sets the runner topology and the secret store. Unit 9's local Docker Compose and CI (build/test) are independent of this decision and proceed regardless.

## References

- design.md section 0 (project boundary; the middleware and NAV are internal read-only sources), section 6 (proposed architecture; static bundle served alongside the read endpoints), and section 8 (the Cloudflare WAF skip rule and the NAV staging-table boundary as fixed external facts).
- ADR-0001 (standalone read-only service in its own repo; the hosting and provisioning surface called out in Consequences).
- ADR-0004 (Node + TypeScript backend, React + TypeScript + Vite frontend, Postgres snapshot store, and the DevOps provisioning gate before the aggregator runs against real sources).
- `.env.example` and README (the config surface this decision provisions: `DATABASE_URL`, `MIDDLEWARE_BASE_URL` + `MIDDLEWARE_AUTH_TOKEN`, the `NAV_*` read-only connection).
- Unit 9's local Docker Compose stack and CI (build/test) workflow, reused by the CD workflow this ADR defers.
