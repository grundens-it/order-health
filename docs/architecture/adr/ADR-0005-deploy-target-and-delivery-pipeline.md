# ADR-0005: Deploy the standalone service on a cloud VM reaching internal NAV and the middleware over an owned, monitored VPN (Alternative B), accepted because the aggregator already reports source-unreachable distinctly from data-stale, so the tunnel is not a hidden freshness risk

- Status: Accepted (operator sign-off: Steve, 2026-07-06). The Architect draft recommended Alternative A (co-located on the internal network) on the reachability constraint alone. The operator leaned Alternative B (cloud VM plus VPN/tunnel) and asked for a firm recommendation rather than a default to the draft. Reassessing (see Recommendation and decision record), the Architect concurs on Alternative B, with Alternative A kept as the documented fallback if the VPN cannot be made a reliable, monitored path. CD (Unit 10) proceeds to target B.
- Deciders: Steve (operator, deciding vote), Architect seat (drafted A, concurs on B).
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

Deploy the service on a **cloud VM (or managed container service) that reaches internal NAV read-only and the middleware read-only endpoints over an owned, monitored VPN or tunnel** (Alternative B). The VM runs the Docker Compose stack Unit 9 defines (Fastify read API plus the node-cron aggregator, the built Vite bundle served alongside the read API, and this service's own Postgres, or a managed Postgres beside the compute). CD is a GitHub Actions workflow that builds the backend image and the frontend bundle and deploys onto that VM.

Two facts make the tunnel an acceptable trade rather than the hidden freshness risk the draft feared:

- The aggregator already reports **source-unreachable distinctly from data-stale** (Unit 8 verified: a source it cannot reach grades `unknown`, not a false freshness RED). So a VPN blip surfaces as a connectivity signal, correctly attributed to the tunnel, not as a spurious NAV staleness incident.
- The VPN is treated as **owned, existing, monitored infrastructure**, not a fragile bespoke dependency stood up for this one service. On that basis the managed-compute and clean-CD upsides of B outweigh A's direct-reachability edge.

**Condition and fallback:** if the VPN/tunnel to NAV and the middleware cannot be made a reliable, monitored path, fall back to Alternative A (co-located on the internal network). Alternative A stays fully specified below for that case, because reachability remains the constraint that cannot be compromised.

## Alternatives considered

### Alternative A: Co-located on the internal network beside the middleware [FALLBACK]

A small VM or single container host on the same internal network as the middleware and NAV, running the Unit 9 Docker Compose stack.

- Network path: direct. NAV read-only (port 1433) and the middleware's read-only endpoints are reachable on the internal network with no tunnel, VPN, or public exposure in the data path. This is the strongest possible answer to the dominant constraint.
- Postgres: this service's own Postgres runs on the same host (a container in the compose stack) or on a nearby managed internal instance. Either way the snapshot store stays on the internal side, close to the aggregator that writes it.
- Secrets: `DATABASE_URL`, `MIDDLEWARE_BASE_URL` + `MIDDLEWARE_AUTH_TOKEN`, and the `NAV_*` read-only credentials are provided to the host as environment/secret files (for example a host-managed `.env` the compose stack reads, or the internal secret store the middleware host already uses), never committed. The read-only posture of every source credential is unchanged.
- Frontend: the Vite build produces a static bundle served by the backend host alongside the read API (the ADR-0004 "static bundle served alongside the backend's read endpoints" shape), so there is one origin and no CORS or second-host concern.
- CD shape: GitHub Actions builds and tests (reusing the Unit 9 CI), builds the backend image and the frontend bundle, and deploys onto the internal host (a pull-and-restart of the compose stack, or a registry push the host pulls). The runner needs a path to the internal host (a self-hosted runner on the internal network, or a deploy step the internal host initiates); this is the main operational detail A introduces and it is smaller than a standing tunnel.
- Cost: a host to provision and patch on the internal network, and self-management of Postgres if it is not a nearby managed instance. This is the price of the direct reachability that the constraint makes non-negotiable.

### Alternative B: Cloud VM or container service with a VPN/tunnel back to the internal network [SELECTED]

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

## Recommendation and decision record

The Architect draft recommended **Alternative A** purely on the reachability constraint: co-location is the only option with direct line-of-sight to internal NAV and the middleware and no tunnel in the aggregator's read path.

The operator (Steve) leaned **Alternative B** (cloud VM plus VPN/tunnel) and asked for a firm recommendation rather than a default to the draft. Reassessing, two things move the decision to B. First, the draft's strongest objection, that a tunnel drop would masquerade as the freshness failure this service exists to catch, does not hold: the aggregator distinguishes source-unreachable (graded `unknown`) from data-stale (freshness RED), verified in Unit 8, so a tunnel blip is attributed to connectivity, not to NAV. Second, when the VPN is owned, existing, monitored infrastructure rather than a bespoke new dependency, B's managed compute, its standard GitHub Actions deploy (no self-hosted internal runner), and its easier host lifecycle are the better operational trade for a single internal read-only service. The Architect therefore concurs with Alternative B.

Alternative A stays the documented fallback: if the VPN to NAV and the middleware cannot be made reliable and monitored, co-location is the correct answer, because reachability is still the constraint that cannot be compromised. Cloudflare Pages remains a reasonable home for the static frontend under either target, but does not change where the backend lives.

This is now a settled decision (target B). The CD pipeline (Unit 10) is built to target B; the concrete VM, provider, VPN path, and secret values are DevOps provisioning work supplied before the deploy runs.

## Consequences

- Secrets management: the read-only NAV credentials (`NAV_HOST`, `NAV_USER`, `NAV_PASSWORD`, and the rest of the `NAV_*` set), the middleware read-only access (`MIDDLEWARE_BASE_URL` + `MIDDLEWARE_AUTH_TOKEN`), and `DATABASE_URL` are provisioned to the chosen host as environment/secret material and never committed (the repo ships only `.env.example`; the real `.env` stays gitignored). Under A they live in the internal host's secret/env store; under B/C/D they live in the platform secret store plus the tunnel's own credentials. Every source credential stays read-only, unchanged from ADR-0001, ADR-0004, and design.md section 0.
- The DevOps provisioning gate from ADR-0004 wires in here: the read-only NAV path and the middleware endpoint base URL and auth must be provisioned and reachable from the chosen target before `AGGREGATOR_ENABLED=true` is set and the node-cron writer runs against real sources. Until then the service runs the ADR-0004 stub mode (typechecks and serves empty, `as_of`-stamped snapshots). The deploy target choice is upstream of that gate: the gate can only be satisfied from a target that has line-of-sight to the internal sources.
- Postgres lands in this service's own datastore regardless of target (co-located container/instance under A, managed Postgres under B/C/D), never in the middleware. The channel dimension and the snapshot/`health_transition` tables from ADR-0002 and ADR-0004 are unaffected by placement.
- Zero changes to the Symmetry middleware and no new write path into NAV, under every option. The Cloudflare WAF skip rule and the NAV staging-table boundary stay external and untouched.
- **Target chosen: Alternative B, so CD (Unit 10) is now built.** A GitHub Actions CD workflow builds the backend image and the frontend bundle and deploys to the cloud VM, with the VPN/tunnel to the internal network as an owned, monitored dependency. The concrete VM, cloud provider, the VPN path to NAV and the middleware, and the secret values are DevOps provisioning work (the ADR-0004 provisioning gate), supplied by Steve and devops before the deploy runs and before `AGGREGATOR_ENABLED=true` reads real sources. Unit 9's local Docker Compose and CI (build/test) are independent of this decision and already merged.

## References

- design.md section 0 (project boundary; the middleware and NAV are internal read-only sources), section 6 (proposed architecture; static bundle served alongside the read endpoints), and section 8 (the Cloudflare WAF skip rule and the NAV staging-table boundary as fixed external facts).
- ADR-0001 (standalone read-only service in its own repo; the hosting and provisioning surface called out in Consequences).
- ADR-0004 (Node + TypeScript backend, React + TypeScript + Vite frontend, Postgres snapshot store, and the DevOps provisioning gate before the aggregator runs against real sources).
- `.env.example` and README (the config surface this decision provisions: `DATABASE_URL`, `MIDDLEWARE_BASE_URL` + `MIDDLEWARE_AUTH_TOKEN`, the `NAV_*` read-only connection).
- Unit 9's local Docker Compose stack and CI (build/test) workflow, reused by the CD workflow this ADR defers.
