# Deploying Order Health to production (ADR-0011)

App Service for Containers, provisioned by Bicep, deployed by GitHub Actions over
OIDC. There is no VM. One script does the provisioning with nothing to fill in.

## TL;DR

```powershell
# 1. Provision everything (RG, Postgres, own Key Vault + secrets, OIDC identity,
#    grants, repo vars, production environment with you as reviewer). Zero input.
.\deploy\deploy-order-health-prod.ps1                 # add -DryRun to preview first

# 2. Merge PR #81 to main (or run the deploy workflow). Approve the production gate.
#    The FIRST deploy fails to pull the image (app identity has no AcrPull yet).
#    That is expected.

# 3. Grant the app identity what it needs, then restart.
.\deploy\deploy-order-health-prod.ps1 -Stage grant

# 4. Verify health, then turn the aggregator on.
.\deploy\deploy-order-health-prod.ps1 -Stage enable
```

Run it from anywhere; you need `az login` and `gh auth login` first.

## What the script fills in for you

- Postgres admin password: generated randomly, stored only in Key Vault. You
  never type or see it. (Retrieve it from the `order-health-database-url` secret
  if you ever need it.)
- Shopify client secret and the optional middleware/NAV secrets: read straight
  from your local `backend/.env` (`-EnvFile` to point elsewhere). Never printed.
- Key Vault: order health gets its OWN vault, `kv-order-health-prod-01`, in its
  own resource group, access-policy model. Nothing depends on a shared vault.
- Required reviewer on the `production` environment: set to you automatically
  (resolved from your GitHub identity).

## What is created

Resource group `rg-order-health-prod-01`, a Postgres flexible server, the own
Key Vault plus its secrets, the App Service (`app-order-health-prod-01`, created
by the Bicep on the first deploy, own P1v3 plan), an OIDC deploy identity
`gh-order-health-deploy` with Contributor on the RG and AcrPush on the ACR, the
three `AZURE_*` repo variables, and the `production` environment.

## The two cross-subscription grants (handled in -Stage grant)

- AcrPull for the app identity on `grundens.azurecr.io` (registry lives in the
  dev subscription).
- `db_datareader` on NAV (`grus-prd-01`) for the app identity. This is a SQL
  grant, so the script runs it via `sqlcmd -G` if present, otherwise prints the
  exact two statements to run as a NAV Entra admin.

## Posture

Ships DISARMED (`REMEDIATION_LIVE_ENABLED=false`). The aggregator stays off until
`-Stage enable`, which only flips it after the app reports healthy. Every source
stays read-only.

## Safety note

The script performs privileged production change (creating a security identity,
role grants, writing secrets). Run it yourself under your own `az`/`gh` login.
Use `-DryRun` first to see every command before anything is created.
