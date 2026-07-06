# Deploying Order Health Observability

This describes how the service is delivered to its runtime target. The pipeline
definition lives in `.github/workflows/cd.yml` and `docker-compose.prod.yml`.

> This pipeline does NOT run and CANNOT deploy anything until the DevOps
> provisioning below is complete: the `production` GitHub Environment (with
> required reviewers and secrets), a cloud VM with Docker, the VM-held
> `order-health.env`, and the owned monitored VPN with line-of-sight to internal
> NAV and the middleware. Until then the workflow is inert: the deploy job waits
> for approval and has no host or key to connect with.

## Target: ADR-0005, Alternative B (accepted)

Per `docs/architecture/adr/ADR-0005-deploy-target-and-delivery-pipeline.md`
(Accepted, operator sign-off Steve, 2026-07-06), the service runs on a **cloud
VM (or managed container service) that reaches internal NAV read-only and the
middleware read-only endpoints over an OWNED, MONITORED VPN or tunnel.** The VM
runs the Docker Compose stack (Postgres snapshot store, one-shot migrate,
Fastify read API plus the node-cron aggregator, and the frontend).

Alternative A (co-located on the internal network) stays the documented fallback
if the VPN cannot be made a reliable, monitored path. The CD pipeline here
targets B.

### Assumption: the VPN is DevOps provisioning, not built here

This pipeline assumes the VM sits behind an **owned, existing, monitored** VPN or
tunnel that gives it line-of-sight to internal NAV (`nav-sql.internal...:1433`,
read-only) and the middleware read-only endpoints
(`middleware.internal...`). Standing up and monitoring that tunnel is DevOps
provisioning work. It is not created, configured, or tested by this repository.
If the tunnel drops, the aggregator grades the affected sources `unknown`
(source-unreachable), distinctly from a freshness RED (ADR-0005 Context), so a
tunnel blip surfaces as connectivity, not as a false NAV staleness incident.

## The CD flow

`.github/workflows/cd.yml` triggers on push to `main` and on manual
`workflow_dispatch`. Two jobs:

1. **build-and-push** (ungated): builds the backend and frontend images from the
   Unit 9 Dockerfiles and pushes them to GHCR
   (`ghcr.io/grundens-it/order-health-backend` and `-frontend`), tagged by commit
   SHA and `latest`, authenticating with the built-in `GITHUB_TOKEN` (no external
   registry secret). This job holds no deploy secrets and touches no host.
2. **deploy** (gated by the `production` environment): copies the compose
   manifest (`docker-compose.yml`, `docker-compose.prod.yml`, and the migration
   SQL) to the VM over SSH, then on the VM logs in to GHCR with the run's
   ephemeral token, `docker compose pull`, `docker compose ... up -d`, and runs
   the one-shot idempotent `migrate` service. The image tag is pinned to the
   commit that was just built.

The VM's own runtime config (`order-health.env`) is never sent by CD; the VM
holds it. The pipeline delivers images plus the compose manifest only.

## How the `production` environment gate stops auto-deploy

The `deploy` job declares `environment: production`. A GitHub Environment with
**required reviewers** blocks the job until a reviewer approves each run. Push to
`main` therefore builds and pushes images, but the deploy pauses for human
approval. It also cannot proceed technically until the environment's deploy
secrets exist.

> Important: if you reference an environment that does not exist yet, GitHub
> auto-creates it WITHOUT protection rules. So the gate is only real once the
> environment is created WITH required reviewers. Create it before relying on the
> gate. Until the deploy secrets are set, the deploy step also fails to connect
> (no host/key), so no VM is ever reached.

### Create the `production` environment

1. Repo Settings > Environments > New environment > name it `production`.
2. Add **Required reviewers** (the operator and/or DevOps). Optionally restrict
   deployment branches to `main`.
3. Add the environment **secrets** and **variables** below.

## Required GitHub Environment secrets and variables

Set these on the `production` environment (Settings > Environments > production).

Secrets (required):

| Name | Purpose |
| --- | --- |
| `DEPLOY_SSH_HOST` | Hostname or IP of the cloud VM to deploy onto. |
| `DEPLOY_SSH_USER` | SSH user on the VM (a member of the `docker` group). |
| `DEPLOY_SSH_KEY`  | Private SSH key for that user (PEM). Public half is in the VM's authorized_keys. |

Variables (optional, have defaults):

| Name | Default | Purpose |
| --- | --- | --- |
| `DEPLOY_SSH_PORT` | `22` | SSH port on the VM. |
| `DEPLOY_DIR` | `/opt/order-health` | Directory on the VM holding the compose files and `order-health.env`. |

Not configured in GitHub: the registry credential. Image push (in CI) and image
pull (on the VM, during the same run) both use the workflow's built-in
`GITHUB_TOKEN`. No long-lived GHCR PAT is stored on the VM.

## One-time VM setup (DevOps, manual)

Done once, out of band, before the first deploy:

1. **Provision the VM** on the chosen cloud, on the owned monitored VPN/tunnel
   that reaches internal NAV and the middleware (see the assumption above).
2. **Install Docker Engine and the Compose v2 plugin.** Add `DEPLOY_SSH_USER` to
   the `docker` group.
3. **Create `DEPLOY_DIR`** (default `/opt/order-health`) owned by that user. CD
   writes the compose files and migration SQL here on each deploy.
4. **Create `order-health.env` in `DEPLOY_DIR`** (mode 600, never committed).
   Base it on `.env.example`. It holds the real source config:
   - `DATABASE_URL` (this service's own Postgres; the compose `db` service, or a
     managed Postgres beside the VM),
   - `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` (if using the compose
     `db` service),
   - `MIDDLEWARE_BASE_URL` and `MIDDLEWARE_AUTH_TOKEN` (read-only bearer token),
   - `NAV_HOST` / `NAV_PORT` / `NAV_DATABASE` / `NAV_USER` / `NAV_PASSWORD` /
     `NAV_ENCRYPT` (read-only NAV login),
   - the cadence knobs (`ORDER_LAYER_CRON`, `INVENTORY_LAYER_CRON`) and any Ops
     threshold overrides,
   - `AGGREGATOR_ENABLED` (see the gate below).
5. **Firewall / cloud security group:** expose ONLY the web port to its intended
   audience. Block `5432` (Postgres) and `8080` (backend) from the public
   internet. The compose base publishes `5432` for local dev and a compose
   override cannot remove a published port, so the security group is the
   authoritative control that keeps Postgres private.

## The `AGGREGATOR_ENABLED` gate (ADR-0004 provisioning gate)

Turning the node-cron writer loose on the real NAV and middleware is a separate
DevOps gate, upstream of and independent from getting the pipeline to deploy.
Keep `AGGREGATOR_ENABLED=false` in `order-health.env` until:

- the VPN path to NAV and the middleware is provisioned, reachable from the VM,
  and monitored, and
- the read-only NAV credentials and the middleware base URL + read-only token are
  provisioned and verified.

While `false`, the service runs the ADR-0004 stub mode: it typechecks and serves
empty, `as_of`-stamped snapshots, contacting no live source. Only after the gate
is satisfied should `AGGREGATOR_ENABLED=true` be set so the aggregator reads real
sources. Deploying the pipeline does not satisfy this gate; provisioning does.

## What this pipeline does NOT do

- It deploys nothing today. It is inert until the `production` environment, its
  secrets, the VM, `order-health.env`, and the VPN are provisioned.
- It adds no write path to the middleware or NAV. Every source stays read-only,
  unchanged from ADR-0001, ADR-0004, and design.md section 0.
- It does not create, configure, or monitor the VPN, and it does not enable the
  aggregator against real sources.
