# Order Health: production deploy runbook (ADR-0011, App Service for Containers)

The code is done and in PR #81. This is the provisioning that only you can run, because it is privileged production change (secrets, role grants, identities). Run top to bottom. Nothing here is destructive; every step is create-or-idempotent. No em dashes anywhere on purpose.

## Facts you will reuse

- App subscription: `grundies-corp-prod` = `c63b42ea-eb59-4b94-ac15-f97c6d902000`
- NAV subscription: `grus-prd-01` = `ba95a0a4-97ac-4f71-b00c-8c6f72966759` (NAV Azure SQL lives here)
- ACR subscription: `grundies-corp-dev` = `4dafd997-8b1e-41ea-b9bc-06d499bef766` (registry `grundens.azurecr.io`, rg `rg-kv-corp-dev-01`)
- Region: West US 3
- Repo: `grundens-it/order-health`
- New resource group: `rg-order-health-prod-01`
- App name (from Bicep): `app-order-health-prod-01`
- Shared prod Key Vault RG: `rg-kv-shared-prod-01` (you must confirm the vault NAME and put it in `infra/bicep/main.bicepparam` where it currently says `REPLACE-ME-kv-shared-prod`)

Set these once in your shell:

```powershell
$APP_SUB   = 'c63b42ea-eb59-4b94-ac15-f97c6d902000'
$NAV_SUB   = 'ba95a0a4-97ac-4f71-b00c-8c6f72966759'
$ACR_SUB   = '4dafd997-8b1e-41ea-b9bc-06d499bef766'
$RG        = 'rg-order-health-prod-01'
$LOC       = 'westus3'
$KV_RG     = 'rg-kv-shared-prod-01'
$KV_NAME   = '<confirm-the-shared-prod-vault-name>'
az account set --subscription $APP_SUB
```

## 1. Resource group

```powershell
az group create -n $RG -l $LOC --subscription $APP_SUB
```

## 2. Postgres (the snapshot store)

Azure Database for PostgreSQL Flexible Server. Pick an admin password, do not paste it into chat or commit it.

```powershell
$PG = 'psql-order-health-prod-01'
az postgres flexible-server create `
  --subscription $APP_SUB -g $RG -l $LOC `
  --name $PG --version 16 `
  --tier Burstable --sku-name Standard_B1ms --storage-size 32 `
  --admin-user oh_admin --admin-password '<CHOOSE-A-STRONG-PASSWORD>' `
  --public-access 0.0.0.0    # allow Azure services; tighten later if you want VNet
az postgres flexible-server db create --subscription $APP_SUB -g $RG -s $PG -d order_health
```

The `DATABASE_URL` the app reads is the whole connection string (it embeds the password, so the entire URL is the secret). It goes in Key Vault in step 4, not here.

## 3. Key Vault: confirm the vault, put its name in the param file

```powershell
az keyvault list --subscription $APP_SUB -g $KV_RG -o table   # find the vault name -> set $KV_NAME
```

Edit `infra/bicep/main.bicepparam` in PR #81: set `keyVaultName` to `$KV_NAME` (replace `REPLACE-ME-kv-shared-prod`). Commit that one-line change to `release/prod-appservice`.

## 4. Key Vault secrets (values never leave your shell)

```powershell
# The DB URL: build it from the Postgres FQDN and your chosen password.
$PGFQDN = az postgres flexible-server show --subscription $APP_SUB -g $RG -n $PG --query fullyQualifiedDomainName -o tsv
az keyvault secret set --vault-name $KV_NAME -n order-health-database-url `
  --value "postgres://oh_admin:<PASSWORD>@$PGFQDN:5432/order_health?sslmode=require"

# Shopify read-only client secret (ADR-0009). Value only, never echo it back.
az keyvault secret set --vault-name $KV_NAME -n order-health-shopify-client-secret --value '<SHOPIFY_CLIENT_SECRET>'

# These two are only read when remediation is ARMED (it ships disarmed). Set them
# now so arming later needs no redeploy. The middleware read path is unauthenticated,
# so the token only matters for the Tier 1 write path.
az keyvault secret set --vault-name $KV_NAME -n order-health-middleware-auth-token --value '<or a placeholder until armed>'
az keyvault secret set --vault-name $KV_NAME -n order-health-nav-toggle-password  --value '<the middleware NAV_TOGGLE_PASSWORD>'
```

## 5. OIDC identity GitHub Actions deploys as (no stored secrets)

Create an app registration, federate it to the repo, and give it what it needs to deploy.

```powershell
$APPREG = az ad app create --display-name 'gh-order-health-deploy' --query appId -o tsv
az ad sp create --id $APPREG
$SPOID = az ad sp show --id $APPREG --query id -o tsv
$TENANT = az account show --query tenantId -o tsv

# Federated credentials: one for pushes to main, one for the production environment
# (deploy.yml runs the deploy job in environment: production).
az ad app federated-credential create --id $APPREG --parameters '{
  \"name\":\"gh-main\",\"issuer\":\"https://token.actions.githubusercontent.com\",
  \"subject\":\"repo:grundens-it/order-health:ref:refs/heads/main\",\"audiences\":[\"api://AzureADTokenExchange\"]}'
az ad app federated-credential create --id $APPREG --parameters '{
  \"name\":\"gh-env-prod\",\"issuer\":\"https://token.actions.githubusercontent.com\",
  \"subject\":\"repo:grundens-it/order-health:environment:production\",\"audiences\":[\"api://AzureADTokenExchange\"]}'
```

Grants for that deploy SP:

```powershell
# Contributor on the app resource group (create/update the App Service + plan + KV refs).
az role assignment create --assignee $APPREG --role Contributor `
  --scope "/subscriptions/$APP_SUB/resourceGroups/$RG"

# AcrPush on the registry, which lives in the DEV subscription.
$ACR_ID = az acr show --subscription $ACR_SUB -n grundens --query id -o tsv
az role assignment create --assignee $APPREG --role AcrPush --scope $ACR_ID

# GOTCHA: the Bicep grants the APP's identity "Key Vault Secrets User" via a role
# assignment (kv-role.bicep). Writing a role assignment needs more than Contributor.
# So also give the deploy SP "Role Based Access Control Administrator" scoped to the
# vault (least-privilege) so the Bicep can create that one assignment:
$KV_ID = az keyvault show --subscription $APP_SUB -g $KV_RG -n $KV_NAME --query id -o tsv
az role assignment create --assignee $APPREG --role "Role Based Access Control Administrator" --scope $KV_ID
# (Alternative: pre-create the app-identity KV grant by hand in step 8 and delete the
#  kv-role module from main.bicep. Either works; the RBAC-admin grant is simpler.)
```

Repo variables GitHub Actions reads (deploy.yml uses vars, not secrets, for OIDC):

```powershell
gh variable set AZURE_CLIENT_ID       -R grundens-it/order-health -b $APPREG
gh variable set AZURE_TENANT_ID       -R grundens-it/order-health -b $TENANT
gh variable set AZURE_SUBSCRIPTION_ID -R grundens-it/order-health -b $APP_SUB
```

## 6. The `production` GitHub Environment (the human gate)

```powershell
# Create it WITH a required reviewer BEFORE anything can deploy. Set reviewer to you.
gh api -X PUT repos/grundens-it/order-health/environments/production `
  -f "reviewers[0][type]=User" -F "reviewers[0][id]=<your-github-user-id>" `
  -F "deployment_branch_policy=null"
```

If the `gh api` reviewer shape fights you, just do it in the UI: Settings > Environments > production > Required reviewers = you, Deployment branches = main. Reviewers FIRST, before the first deploy.

## 7. First deploy (creates the App Service + its managed identity)

Merging PR #81 to main triggers `deploy.yml`, or run it manually once the vars exist:

```powershell
gh workflow run deploy.yml -R grundens-it/order-health --ref release/prod-appservice
```

The build job pushes the image to ACR. The deploy job pauses on the production gate; approve it. Bicep creates `app-order-health-prod-01` with a system-assigned identity. The image pull will likely FAIL on this first run because the app identity does not have AcrPull yet. That is expected. Continue to step 8, then restart the app.

## 8. Post-creation grants for the APP identity (cross-subscription)

```powershell
$MI = az webapp show --subscription $APP_SUB -g $RG -n app-order-health-prod-01 --query identity.principalId -o tsv

# AcrPull on the registry (dev sub) so the app can pull its own image.
az role assignment create --assignee-object-id $MI --assignee-principal-type ServicePrincipal `
  --role AcrPull --scope $ACR_ID

# db_datareader on NAV. This is a SQL-level grant, not an Azure RBAC role. Connect to
# the NAV database as an Entra admin and run:
#   CREATE USER [app-order-health-prod-01] FROM EXTERNAL PROVIDER;
#   ALTER ROLE db_datareader ADD MEMBER [app-order-health-prod-01];
# (The user name is the App Service name; the identity is resolved by Entra.)

# Restart so the pull + identity take effect.
az webapp restart --subscription $APP_SUB -g $RG -n app-order-health-prod-01
```

## 9. Flip the aggregator on, verified (ADR-0004 gate)

The app ships with `AGGREGATOR_ENABLED=false` (serves empty snapshots, touches no source). Only after you confirm the app can reach NAV and the middleware from Azure:

```powershell
# Confirm health first.
$HOST = az webapp show --subscription $APP_SUB -g $RG -n app-order-health-prod-01 --query defaultHostName -o tsv
curl "https://$HOST/api/health/ping"   # expect {"ok":true,...}

# Then enable the aggregator and restart.
az webapp config appsettings set --subscription $APP_SUB -g $RG -n app-order-health-prod-01 `
  --settings AGGREGATOR_ENABLED=true
az webapp restart --subscription $APP_SUB -g $RG -n app-order-health-prod-01
```

Remediation stays DISARMED (`REMEDIATION_LIVE_ENABLED=false`). Do not change that here; arming is a separate reviewed decision.

## Order that matters

1 RG, 2 Postgres, 3 confirm KV name into the param file, 4 KV secrets, 5 OIDC identity + grants + repo vars, 6 production environment WITH reviewer, 7 first deploy (image pull fails, fine), 8 app-identity grants + restart, 9 verify then enable aggregator.

## The one thing to double check before you start

`infra/bicep/main.bicepparam` still says `keyVaultName = 'REPLACE-ME-kv-shared-prod'`. The deploy will not work until that is the real vault name. That is step 3.
