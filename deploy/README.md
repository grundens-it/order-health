# Deploying Order Health to production (ADR-0011)

App Service for Containers, provisioned by Bicep, deployed by GitHub Actions over
OIDC. There is no VM. The deploy is now PIPELINE-NATIVE: a push to main creates
the resource group, the Key Vault (and the app-identity access policy), the App
Service, sets the image, migrates the database on boot, and runs the health
smoke. A small one-time BOOTSTRAP handles only what cannot live in the pipeline:
the deploy identity, the generated Postgres password, the secret VALUES, and two
privileged cross-boundary grants.

## What the pipeline does (push to main)

`.github/workflows/deploy.yml` + `infra/bicep/main.bicep`:

- `az group create` for `rg-order-health-prod-01` (idempotent).
- Bicep CREATES the Key Vault `kv-order-health-prod-01` (access-policy model) and
  grants the app's system-assigned identity get/list on secrets, in the same
  template.
- Bicep creates Log Analytics, App Insights, the App Service `app-order-health-prod-01`
  (own P1v3 plan) and all its settings (Key Vault references for secrets).
- Sets the container image to the built commit SHA and runs the `/api/health/ping`
  smoke with warmup retries.
- On every boot the backend applies `db/migrations/*.sql` before it serves and
  before the aggregator starts (migrate-on-boot, idempotent). There is no
  separate migrate job and no local psql step.

## What the bootstrap does (one time)

`deploy/bootstrap-order-health-prod.ps1`. Run it yourself under your own `az`/`gh`
login. Three stages:

```powershell
# 1. provision: OIDC deploy identity + federated creds, deploy role grants
#    (Contributor on the RG, AcrPush on the ACR), the three AZURE_* repo vars,
#    and the production environment with you as reviewer. Creates the RG so the
#    Contributor scope exists before the first push. Zero prompts.
.\deploy\bootstrap-order-health-prod.ps1                 # add -DryRun to preview

# 2. Merge to main (or run the deploy workflow). Approve the production gate.
#    The pipeline creates the RG, the Key Vault (+ app access policy), and the
#    App Service. The FIRST deploy fails to pull the image (the app identity has
#    no AcrPull yet). That is expected.

# 3. grant: create Postgres (admin password generated, stored only in Key Vault),
#    seed the KV secret VALUES (DATABASE_URL etc.), grant the app identity AcrPull
#    (cross-subscription) and NAV db_datareader, then restart.
.\deploy\bootstrap-order-health-prod.ps1 -Stage grant

# 4. enable: verify health, then flip AGGREGATOR_ENABLED=true.
.\deploy\bootstrap-order-health-prod.ps1 -Stage enable
```

## Why these stay in bootstrap (not the pipeline)

- Postgres server + database + the `order-health-database-url` secret: the admin
  password is generated once and is inherently a bootstrap secret, and the URL
  embeds it. Postgres is a stateful, create-once resource that does not benefit
  from per-push redeployment the way the stateless app does. So it stays in
  bootstrap along with its secret. (Reconcile decision, PR #82.)
- The other secret VALUES (Shopify client secret, middleware token, NAV toggle
  password): read straight from your local `backend/.env` (`-EnvFile` to point
  elsewhere), never printed. Only VALUES are bootstrap; the vault and the app
  access policy are Bicep.
- AcrPull for the app identity on `grundens.azurecr.io`: the registry lives in
  the `grundies-corp-dev` subscription, so this is a role assignment in a
  DIFFERENT subscription than the pipeline's deploy identity governs. Expressing
  it in Bicep would require granting the deploy identity role-assignment rights
  across the subscription boundary; keeping it a one-time human grant is the
  smaller blast radius. See PR #82.
- `db_datareader` on NAV (`grus-prd-01`): a SQL grant run as a NAV Entra admin.
  The script runs it via `sqlcmd -G` if present, otherwise prints the exact two
  statements.
- The OIDC deploy identity, its federated credentials, and the deploy role
  grants: the identity the pipeline authenticates as cannot create itself.

## Posture

Ships DISARMED (`REMEDIATION_LIVE_ENABLED=false`). The aggregator stays off until
`-Stage enable`, which only flips it after the app reports healthy. Every source
stays read-only.

## Safety note

The bootstrap performs privileged production change (creating a security
identity, role grants, writing secrets, creating Postgres). Run it yourself under
your own `az`/`gh` login. Use `-DryRun` first to see every command.
