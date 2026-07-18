# ADR-0011: Supersede ADR-0005 and deploy on Azure App Service for Containers via Bicep and OIDC, the Grundens house pattern, because ADR-0005's internal-network premise is factually false

## Status

Draft (2026-07-16). Drafted by the Architect seat, Session A. Supersedes ADR-0005 (Accepted 2026-07-06). Awaiting operator sign-off (Steve).

## Context

ADR-0005 decided that order health deploys on a cloud VM reaching NAV and the middleware over an owned, monitored VPN, delivered as a Docker Compose stack over SSH from GitHub Actions. That decision rested on one load-bearing premise, stated in its Context as the constraint that "dominates every option":

> "This service is useless unless it can reach the two sources it materializes its snapshot from, and both are internal ... `MIDDLEWARE_BASE_URL=https://middleware.internal.grundens.example` ... `NAV_HOST=nav-sql.internal.grundens.example` ... Both hosts sit on the Grundens internal network."

**That premise is false.** It was written against placeholder hostnames, not the real endpoints. Verified 2026-07-16:

- The middleware is **public HTTPS** at `https://middleware.grundens.com`. This repo's own `.env.example` says so, and the sibling app `func-invsync-monitor-prod-01` hardcodes exactly that base URL in its Bicep and reaches it from a plain Azure Function with no VPN.
- NAV is **Azure SQL** at `sql-grus-prd-01.database.windows.net`, a public endpoint authenticated by Microsoft Entra. This repo's `.env.example` says so, and further states `NAV_AUTH_MODE=aad-msi` means "managed identity (deployed in Azure App Service)". The application was already built expecting App Service and a managed identity.

There is no internal network to reach and no VPN requirement. ADR-0005 solved a problem that does not exist, and in doing so it made order health the only Grundens application deployed by hand-rolled SSH, with a VM to patch and a long-lived SSH key to rotate.

Meanwhile the Grundens house deploy pattern is well established and consistent across every sibling repo (`nav-trace-viewer`, `func-invsync-monitor-prod-01`, `preseason-order-confirmation-tool`, `VendorManagementPortal-`):

- OIDC federation via `azure/login` with `permissions: id-token: write`. No PATs, no stored client secrets.
- Bicep at `infra/bicep/main.bicep`, applied with `az deployment group create` into an existing resource group, with `what-if` surfaced before apply and the Bicep step skipped on code-only pushes.
- Secrets in Key Vault, consumed as `@Microsoft.KeyVault(SecretUri=...)` references by a system-assigned managed identity granted Key Vault Secrets User. Secret values are populated out of band, never in source or parameters.
- CAF-prefixed names, West US 3 as the house default region.

And for a containerized long-lived HTTP API specifically, the pattern is already running in production three times over. Verified in subscription `grundies-corp-prod` (`c63b42ea-eb59-4b94-ac15-f97c6d902000`):

| App | Resource group | Kind | Plan |
| --- | --- | --- | --- |
| `app-bart-api-prod-01` | `rg-bart-api-prod-01` | `app,linux,container` | `plan-prod-01` |
| `app-penny-api-prod-01` | `rg-netptune-api-prod-01` / `rg-penny-api-prod-01` | `app,linux,container` | `plan-prod-01` |
| `app-neptune-api-prod-01` | `rg-netptune-api-prod-01` | `app,linux,container` | `plan-prod-01` |

`app-bart-api-prod-01` concretely: `linuxFxVersion: DOCKER|grundens.azurecr.io/bartrestapi:latest`, `alwaysOn: true`, `httpsOnly: true`, `identity: SystemAssigned`, `virtualNetworkSubnetId: null`, on the shared `plan-prod-01` (P1v2, Linux, West US 3, in `rg-plan-corp-prod-001`). Images come from **ACR** (`grundens.azurecr.io`), not GHCR. There is a shared Key Vault resource group at `rg-kv-shared-prod-01` (West US 3).

This ADR decides the deploy target only. It does not touch ADR-0001 (standalone read-only service), ADR-0004 (Fastify + node-cron + React + Postgres, and the provisioning gate), ADR-0009 (read-only Shopify client), or ADR-0010 (operator-triggered remediation, disarmed by default).

## Decision

Supersede ADR-0005. Deploy order health as **Azure App Service for Containers (Linux)** on the shared `plan-prod-01` in West US 3, provisioned by **Bicep** at `infra/bicep/main.bicep` and delivered by a **GitHub Actions workflow using OIDC federation**, with images in **ACR**, secrets as **Key Vault references**, and NAV reached by the app's **system-assigned managed identity** granted `db_datareader`. No VM, no VPN, no SSH, no VNet integration.

## Alternatives considered

### Alternative A: Keep ADR-0005 (cloud VM plus VPN, Compose over SSH)

- Pros: already decided and partially built; the CD workflow exists and has been hardened with smoke validation and a rollback path.
- Cons: the justifying premise is factually wrong, so the central trade it argues (managed compute in exchange for an acceptable tunnel) is a trade against nothing. It makes order health the only Grundens app on a bespoke deploy path, and it *adds* a long-lived secret (the SSH deploy key, a GitHub-secret/authorized_keys bridge needing a rotate-both procedure) to reach sources that need no tunnel at all. It also leaves us a VM to patch and a Compose stack to babysit. Rejected: sunk drafting cost is not a reason to keep a decision whose premise does not hold.

### Alternative B: App Service for Containers on the shared `plan-prod-01` [SELECTED]

- Pros: it is the observed house pattern for exactly this workload shape, already running three times in production. `alwaysOn: true` keeps the node-cron aggregator resident, which is the single hardest requirement to satisfy on serverless options. The service is already containerized, so this is the least code rework of any option. Managed identity to NAV **removes** credentials rather than adding them: with `NAV_AUTH_MODE=aad-msi` there is no NAV password anywhere, which the app already supports. Reusing `plan-prod-01` avoids standing up compute. No VNet needed, matching every sibling.
- Cons: needs a new Azure Database for PostgreSQL Flexible Server (the only existing one, `unified-business-portal`, belongs to another app and must not be shared). Requires switching the image registry from GHCR to ACR. The shared plan means order health's aggregator competes for CPU with bart/penny/neptune, so the plan's headroom should be checked before cutover.

### Alternative C: Azure Container Apps

- Pros: modern container platform, per-revision traffic splitting, scale-to-zero.
- Cons: scale-to-zero is actively wrong for this workload; a scaled-to-zero aggregator stops writing snapshots, which is the one thing the service exists to do, so it would need `min-replicas=1` and the headline benefit evaporates. No Grundens app currently runs on Container Apps, so it introduces a new platform, new Bicep modules, and a new operational surface for no benefit over B. Rejected.

### Alternative D: Azure Functions plus Static Web App

- Pros: the most literal match to the two closest siblings (`func-invsync-monitor-prod-01`, `nav-trace-viewer`), both of which are NAV-adjacent.
- Cons: the resemblance is superficial. Those are a timer-triggered PowerShell function and a static site with a thin Functions proxy. Order health is a long-lived Fastify API with a node-cron scheduler and a persistent Postgres connection. Adopting D means rewriting the aggregator as timer Functions, re-homing the Postgres connection (Functions plus a pooled Postgres connection is a known-awkward pairing), and splitting the deploy across two targets. Large rework of a working, tested stack to conform to the letter of a pattern rather than its intent. Rejected.

## Recommendation and decision record

Alternative B. It is simultaneously the house standard, the least rework, and the only option that reduces the credential surface instead of expanding it. A is rejected because a decision built on a false premise should be corrected, not preserved. C and D are rejected because they impose real rework or real operational risk to satisfy a pattern that B already satisfies more closely.

Honest concern worth surfacing rather than burying: `plan-prod-01` is a single P1v2 Linux plan already hosting three production APIs. Order health adds an always-on container plus a cron aggregator doing periodic NAV and Shopify reads. DevOps should confirm the plan's CPU and memory headroom before cutover, and be prepared to scale the plan up or give order health its own plan. That is a provisioning check, not a reason to prefer another alternative.

## Consequences

What changes after acceptance:

- ADR-0005 is **superseded**. The VM, the VPN, `docker-compose.prod.yml` as a deploy artifact, the SSH deploy path in `.github/workflows/cd.yml`, and the `DEPLOY_SSH_*` secret set are all retired. The Pattern 3 SSH-key rotation runbook entry retires with them: the bridge ceases to exist, which is the best possible outcome for a bridged secret.
- Local `docker-compose.yml` is **unaffected**. It remains the dev stack (ADR-0004, Unit 9). Only the production delivery path changes.
- The registry moves from **GHCR to ACR** (`grundens.azurecr.io`), matching bart/penny/neptune.
- NAV auth in production becomes `NAV_AUTH_MODE=aad-msi`. The App Service system-assigned identity is granted `db_datareader` on `sqldb-nav18-grus-prd-01`. Note this is a **cross-subscription grant**: NAV lives in `grus-prd-01` (`ba95a0a4-...`) while the app lives in `grundies-corp-prod` (`c63b42ea-...`). Entra identities work across subscriptions, but the grant is a deliberate step.
- Secrets that remain (the Shopify client secret, `MIDDLEWARE_AUTH_TOKEN` and `NAV_TOGGLE_PASSWORD`, both only read when remediation is armed, and the Postgres password unless Entra auth is used) move to Key Vault as `@Microsoft.KeyVault(...)` references read by the managed identity. No secret in Bicep, parameters, or source.
- ADR-0010's posture is unchanged: production ships **disarmed** (`REMEDIATION_LIVE_ENABLED=false`), and arming stays a separate reviewed decision.
- The ADR-0004 provisioning gate is unchanged: `AGGREGATOR_ENABLED` stays false until NAV and middleware reachability are verified from the App Service.

Open questions this ADR does NOT settle, flagged rather than assumed:

- **Frontend serving.** `frontend/Dockerfile` currently runs the **Vite dev server**, which is not production-appropriate. Either the Fastify backend serves the built static bundle from one App Service (the ADR-0004 "static bundle served alongside the read endpoints" shape, and the simpler single-origin answer), or the frontend becomes a second App Service or a Static Web App. This needs a decision before the Bicep is final; the single-container option is the Architect's leaning.
- **ACR pull auth.** bart uses `DOCKER_REGISTRY_SERVER_PASSWORD` (admin credentials). The better pattern is the managed identity with `AcrPull`. Deviating from bart here is an improvement, not drift, but DevOps should confirm ACR admin-user policy.
- **Postgres sizing and auth.** A new Flexible Server; tier and whether to use Entra auth (removing the last password) are DevOps calls.

Work handed to other seats:

- **DevOps seat:** write `infra/bicep/main.bicep` (App Service on the existing `plan-prod-01`, system-assigned identity, `alwaysOn`, `httpsOnly`, health check, Key Vault references, new Postgres Flexible Server) and replace `cd.yml` with the OIDC + Bicep + ACR workflow modeled on `func-invsync-monitor-prod-01`'s `deploy.yml`. Confirm `plan-prod-01` headroom. Retire the SSH path and its runbook entry.
- **PM seat:** re-cut issues #75 through #79, which are written against the now-dead VM/SSH target, and re-sequence the release umbrella #74.
- **QA seat:** the deploy smoke test moves from an SSH `curl` loop to an App Service health check against `/api/health/ping`.

## References

- ADR-0005 (superseded here), ADR-0001, ADR-0004 (stack and the provisioning gate), ADR-0009, ADR-0010.
- `.env.example` (`MIDDLEWARE_BASE_URL=https://middleware.grundens.com`, `NAV_HOST=sql-grus-prd-01.database.windows.net`, `NAV_AUTH_MODE=aad-msi` "managed identity (deployed in Azure App Service)"), the evidence the internal-network premise is false.
- `grundens-it/func-invsync-monitor-prod-01`: `.github/workflows/deploy.yml` (OIDC, what-if, Bicep) and `infra/bicep/main.bicep` (Key Vault references, managed identity, existing-plan reuse), the closest deploy template.
- `grundens-it/nav-trace-viewer`: `infra/bicep/main.bicep` (CAF naming, West US 3 default, KV secret sync at deploy).
- Live Azure inspection 2026-07-16, subscription `grundies-corp-prod`: `app-bart-api-prod-01` config and the shared `plan-prod-01`.
