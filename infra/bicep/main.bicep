// ============================================================================
// infra/bicep/main.bicep
// Order Health Observability: Azure App Service for Containers (ADR-0011).
//
// Grundens house conventions: OIDC deploy (no PATs), no secrets inlined in
// source, Key Vault references for every secret, system-assigned managed
// identity so NAV is reached with NO stored credential (NAV_AUTH_MODE=aad-msi),
// CAF names, West US 3 default. Idempotent; safe to re-run. Rollback is a
// redeploy of a prior image tag.
//
// Supersedes the ADR-0005 VM + Compose + SSH path. There is no VM.
//
// Secret VALUES never appear here. They are populated in Key Vault out of band
// and consumed as @Microsoft.KeyVault(SecretUri=...) references by the app's
// managed identity.
// ============================================================================
targetScope = 'resourceGroup'

@description('Workload code used in resource names (CAF: app-<workload>-<env>-01).')
param workload string = 'order-health'

@allowed([ 'dev', 'prod' ])
param env string = 'prod'

@description('Azure region. Grundens house default is West US 3.')
param location string = 'westus3'

// --- Compute -------------------------------------------------------------
// DECISION (ADR-0011 + DevOps capacity check 2026-07-16): the shared
// plan-prod-01 (P1v2, 3.5 GB) runs at 68% memory average and 73% peak across
// bart + penny + neptune, leaving roughly 1.1 GB. CPU is idle (4% avg), so
// memory is the binding constraint. This service is not a thin API: the
// aggregator ingests up to NAV_ORDER_INGEST_LIMIT (1000) orders with lines plus
// per-SKU Shopify FS reads on a cron, so its working set spikes. Putting it on
// the shared plan risks memory pressure on three existing production APIs.
// Default is therefore a DEDICATED plan. To reuse a shared plan instead, pass
// existingPlanResourceId and the dedicated plan is skipped.
@description('Resource id of an EXISTING App Service plan to reuse. Empty (default) creates a dedicated plan, the recommended posture given the capacity note above.')
param existingPlanResourceId string = ''

@description('SKU for the dedicated plan when existingPlanResourceId is empty. P1v3 is 2 vCPU / 8 GB, room for the aggregator burst.')
param planSkuName string = 'P1v3'

// --- Image ---------------------------------------------------------------
@description('ACR login server. NOTE: grundens.azurecr.io lives in the grundies-corp-dev subscription (rg-kv-corp-dev-01), so the AcrPull grant is cross-subscription and is made out of band. See docs/deploy.md.')
param acrLoginServer string = 'grundens.azurecr.io'

@description('Backend image repository in ACR.')
param imageRepository string = 'order-health'

@description('Image tag to run. CD passes the commit SHA; rollback passes a prior SHA.')
param imageTag string = 'latest'

// --- Key Vault -----------------------------------------------------------
@description('Existing Key Vault holding this service secrets.')
param keyVaultName string

@description('Resource group of the Key Vault (may differ from this RG).')
param keyVaultResourceGroup string = resourceGroup().name

@description('KV secret holding the full DATABASE_URL. The URL embeds the password, so the whole URL is the secret.')
param databaseUrlSecretName string = 'order-health-database-url'

@description('KV secret holding the Shopify client secret (ADR-0009 read-only client).')
param shopifyClientSecretName string = 'order-health-shopify-client-secret'

@description('KV secret holding the middleware bearer token. Only read when remediation is ARMED (ADR-0010); ships disarmed.')
param middlewareAuthTokenSecretName string = 'order-health-middleware-auth-token'

@description('KV secret holding the NAV write-gate password for gated remediation tools. Only read when ARMED.')
param navTogglePasswordSecretName string = 'order-health-nav-toggle-password'

// --- Sources (non-secret) ------------------------------------------------
@description('Middleware base URL. Public HTTPS: no VPN, no VNet (ADR-0011).')
param middlewareBaseUrl string = 'https://middleware.grundens.com'

@description('NAV Azure SQL server FQDN. Public endpoint + Entra auth (ADR-0011). Supplied by main.bicepparam; no default here so the template stays cloud-agnostic (linter: no-hardcoded-env-urls).')
param navHost string

@description('NAV database name. Supplied by main.bicepparam.')
param navDatabase string

@description('NAV company prefix. Every NAV table is prefixed with this plus a dollar sign (GRUS = Grundens US). A wrong value reads another company data.')
param navCompany string = 'GRUS'

// --- Gates ---------------------------------------------------------------
@description('ADR-0004 provisioning gate. Stays FALSE until NAV + middleware reachability is verified from the App Service. While false the service serves empty as_of-stamped snapshots and contacts no live source.')
param aggregatorEnabled bool = false

@description('ADR-0010. Remediation ships DISARMED. Never default this true; arming is a separate reviewed decision.')
param remediationLiveEnabled bool = false

@description('Shopify shop domain (not a secret).')
param shopifyShop string = 'grundens.com'

@description('Shopify API client id (not a secret).')
param shopifyClientId string = ''

var appName  = 'app-${workload}-${env}-01'
var planName = 'plan-${workload}-${env}-01'
var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = if (empty(existingPlanResourceId)) {
  name: planName
  location: location
  sku: {
    name: planSkuName
    capacity: 1
  }
  kind: 'linux'
  properties: {
    reserved: true // required for Linux
  }
}

var planId = empty(existingPlanResourceId) ? plan.id : existingPlanResourceId

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
  scope: resourceGroup(keyVaultResourceGroup)
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${appName}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appi 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${appName}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

// Key Vault references. The managed identity resolves these at runtime; no
// secret value lands in Bicep, in a parameter file, or in git.
var kvUri = kv.properties.vaultUri
var databaseUrlRef       = '@Microsoft.KeyVault(SecretUri=${kvUri}secrets/${databaseUrlSecretName})'
var shopifyClientSecretRef = '@Microsoft.KeyVault(SecretUri=${kvUri}secrets/${shopifyClientSecretName})'
var middlewareTokenRef   = '@Microsoft.KeyVault(SecretUri=${kvUri}secrets/${middlewareAuthTokenSecretName})'
var navTogglePasswordRef = '@Microsoft.KeyVault(SecretUri=${kvUri}secrets/${navTogglePasswordSecretName})'

resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  kind: 'app,linux,container'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: planId
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'DOCKER|${acrLoginServer}/${imageRepository}:${imageTag}'
      // The node-cron aggregator must stay resident. Without alwaysOn the app
      // unloads when idle and stops writing snapshots, which is the one thing
      // this service exists to do.
      alwaysOn: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      healthCheckPath: '/api/health/ping'
      acrUseManagedIdentityCreds: true // AcrPull via MSI: no registry password
      appSettings: [
        { name: 'WEBSITES_PORT', value: '8080' }
        { name: 'PORT', value: '8080' }
        { name: 'HOST', value: '0.0.0.0' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appi.properties.ConnectionString }

        // Sources. Both are public endpoints: no VPN, no VNet integration.
        { name: 'MIDDLEWARE_BASE_URL', value: middlewareBaseUrl }
        { name: 'NAV_HOST', value: navHost }
        { name: 'NAV_PORT', value: '1433' }
        { name: 'NAV_DATABASE', value: navDatabase }
        { name: 'NAV_ENCRYPT', value: 'true' }
        { name: 'NAV_COMPANY', value: navCompany }
        // The point of App Service here: NAV needs NO stored credential. The
        // system-assigned identity is granted db_datareader out of band.
        { name: 'NAV_AUTH_MODE', value: 'aad-msi' }

        // Gates.
        { name: 'AGGREGATOR_ENABLED', value: toLower(string(aggregatorEnabled)) }
        { name: 'REMEDIATION_LIVE_ENABLED', value: toLower(string(remediationLiveEnabled)) }
        { name: 'REMEDIATION_KILL_SWITCH', value: 'false' }

        // Shopify read-only client (ADR-0009).
        { name: 'SHOPIFY_AUTH_MODE', value: 'client_credentials' }
        { name: 'SHOPIFY_SHOP', value: shopifyShop }
        { name: 'SHOPIFY_API_VERSION', value: '2025-01' }
        { name: 'SHOPIFY_CLIENT_ID', value: shopifyClientId }

        // Secrets, by reference only.
        { name: 'DATABASE_URL', value: databaseUrlRef }
        { name: 'SHOPIFY_CLIENT_SECRET', value: shopifyClientSecretRef }
        { name: 'MIDDLEWARE_AUTH_TOKEN', value: middlewareTokenRef }
        { name: 'NAV_TOGGLE_PASSWORD', value: navTogglePasswordRef }
      ]
    }
  }
}

// Let the app identity read its own secrets.
module kvRole 'kv-role.bicep' = {
  name: 'kv-secrets-user'
  scope: resourceGroup(keyVaultResourceGroup)
  params: {
    keyVaultName: keyVaultName
    principalId: app.identity.principalId
    roleDefinitionId: kvSecretsUserRoleId
  }
}

output appName string = app.name
output defaultHostname string = app.properties.defaultHostName
output planUsed string = planId
@description('Grant this principal db_datareader on NAV (cross-subscription: grus-prd-01) and AcrPull on grundens.azurecr.io (cross-subscription: grundies-corp-dev). See docs/deploy.md.')
output managedIdentityPrincipalId string = app.identity.principalId
