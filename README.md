# order-health

Order Health Observability dashboard for Grundens: one surface that shows, at a glance, whether order and inventory flow across DTC and wholesale is healthy right now, and if not, which order or which pipe is unhealthy and what tool fixes it.

This is a **standalone, read-only** observability service. It is a separate Grundens project and does **not** modify the Symmetry Commerce warehouse-splitter middleware. It reads the middleware's existing read-only HTTP endpoints and NAV read-only, materializes its own health snapshot in its own datastore, and serves its own two-layer UI.

## Where to start

- `docs/kickoffs/order-health-observability.md`: the round kickoff brief (self-contained; sequences and builds the design).
- `docs/architecture/design.md`: the order-health model. Read section 0 (project boundary) and 5A (Inventory Sync Monitor, the reference subsystem) first.
- `docs/architecture/adr/`: the architecture decisions:
  - ADR-0001: standalone read-only service (not an in-app tab in the middleware).
  - ADR-0002: materialized snapshot read-model in this service's own store.
  - ADR-0004: service implementation stack (Accepted: Node + TypeScript backend, React + TypeScript frontend).
- `demo/order-health-dashboard-demo.html`: the visual and interaction spec.

## Boundary

The middleware is production code owned by Symmetry Commerce. This project adds no code, endpoints, migrations, or tables to it, and does not couple to its release cycle. NAV access is read-only. Remediation actions call the middleware's existing authenticated endpoints or documented ops runbooks; they add no mutation path to the middleware.

## Repository layout (Unit 0 scaffold)

```
shared/            Shared TypeScript types: Channel, Verdict, the as_of envelope, and the read-model row shapes.
backend/           Node + TypeScript + Fastify. Read API off the snapshot plus the scheduled health aggregator.
frontend/          React + TypeScript + Vite. The two-layer dark-theme UI shell and its single route.
db/migrations/     Plain SQL migrations for this service's own Postgres datastore (0001_init.sql).
.env.example       Documented environment: DATABASE_URL, middleware and NAV read-only access, cadence knobs.
```

The datastore engine is **Postgres** (ADR-0004 left the engine to Unit 0; Postgres is chosen for a real snapshot store, a health_transition audit table, and freshness queries). The channel dimension (DTC vs wholesale) is a first-class column from the first migration, so wholesale is never mis-graded as an orphan.

## How to run

Prerequisites: Node 20+, and (for the aggregator and persisted snapshots) a Postgres database. The scaffold typechecks and the read API runs without a live database or live sources; in that mode it serves empty, as_of-stamped snapshots.

```bash
# 1. Install all workspaces from the repo root.
npm install

# 2. Configure environment (never commit the real .env).
cp .env.example .env    # then fill in DATABASE_URL and, when provisioned, the read-only source access

# 3. Apply the migration to this service's own Postgres (DevOps-gated; do not run against NAV or the middleware).
psql "$DATABASE_URL" -f db/migrations/0001_init.sql

# 4. Typecheck everything.
npm run typecheck

# 5. Run the backend (Fastify read API + scheduled aggregator) on :8080.
npm run dev:backend

# 6. Run the frontend (Vite dev server) on :5173; it proxies /api to the backend.
npm run dev:frontend
```

## Local development with Docker (WSL2 + Docker)

The whole stack (Postgres, migration, backend, frontend) comes up with one command.
No live NAV or middleware access is configured, so it serves empty, as_of-stamped
snapshots. Requires Docker with the Compose v2 plugin (Docker Desktop on WSL2 is fine).

```bash
# From the repo root: build the images and start the stack.
docker compose up --build
```

- Dashboard (UI): http://localhost:5173
- Read API (backend): http://localhost:8080/api/health/pipelines
- The Vite dev server proxies the UI's `/api` calls to the `backend` service.

The `migrate` service applies `db/migrations/0001_init.sql` to the local Postgres
once it is healthy, then exits. It is idempotent, so re-running the stack is safe.

```bash
# Re-run just the migration (for example after wiping the volume).
docker compose run --rm migrate

# Tear down the stack.
docker compose down

# Tear down AND delete the Postgres data volume (start fresh).
docker compose down -v
```

Local dev defaults (db name / user / password `order_health`) are baked into
`docker-compose.yml`. They are non-secret local values; override them with a
gitignored `.env` in the repo root if needed. Never put real NAV or middleware
credentials there: the source clients stay stubbed for local dev.

Read endpoints (each returns `{ as_of, data }`):

- `GET /api/health/pipelines`: per-pipe freshness/liveness snapshot.
- `GET /api/health/orders?channel=dtc|wholesale|all`: per-order lifecycle snapshot.

### What is real vs stubbed in Unit 0

Real: the monorepo, the shared types, the Postgres snapshot schema, the Fastify read API and its as_of envelope, the snapshot repository, the scheduled-writer wiring (node-cron on the configured cadences), and the React two-layer shell with the channel filter and shape-encoded verdict chips. Stubbed (gated on DevOps provisioning of read-only source access): the middleware HTTP client, the NAV client, and therefore the verdict computations, which return placeholder data. Phase W units replace the stubs with real reads and real verdict logic behind the same typed interfaces.
