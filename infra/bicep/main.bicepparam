// Parameters for the prod deploy (ADR-0011).
// NO SECRET VALUES HERE. Secrets live in Key Vault and are consumed as
// @Microsoft.KeyVault references by the app's managed identity. Only names,
// hostnames, and gates appear in this file.
using './main.bicep'

param workload = 'order-health'
param env = 'prod'
param location = 'westus3'

// Dedicated plan. plan-prod-01 sits at 68% memory average / 73% peak on a
// P1v2 (3.5 GB) across bart + penny + neptune; the aggregator's burst would
// put three production APIs under memory pressure. See the note in main.bicep.
// To reuse the shared plan instead, set this to its resource id.
param existingPlanResourceId = ''
param planSkuName = 'P1v3'

param acrLoginServer = 'grundens.azurecr.io'
param imageRepository = 'order-health'
// imageTag is passed on the command line by the workflow (commit SHA).
param imageTag = 'latest'

// Key Vault: order health owns its own vault in its own RG. The deploy script
// creates it (access-policy model) and populates the secrets. No REPLACE-ME,
// nothing to look up: the defaults are correct.
param keyVaultName = 'kv-order-health-prod-01'
param keyVaultResourceGroup = 'rg-order-health-prod-01'

param databaseUrlSecretName = 'order-health-database-url'
param shopifyClientSecretName = 'order-health-shopify-client-secret'
param middlewareAuthTokenSecretName = 'order-health-middleware-auth-token'
param navTogglePasswordSecretName = 'order-health-nav-toggle-password'

// Sources: both public. No VPN, no VNet.
param middlewareBaseUrl = 'https://middleware.grundens.com'
param navHost = 'sql-grus-prd-01.database.windows.net'
param navDatabase = 'sqldb-nav18-grus-prd-01'
param navCompany = 'GRUS'

// GATES. Both stay false for the first deploy.
// aggregatorEnabled flips true only after NAV + middleware reachability is
// verified from the App Service and the identity has db_datareader (ADR-0004).
param aggregatorEnabled = false
// remediationLiveEnabled NEVER ships true (ADR-0010). Arming is a separate,
// reviewed, out-of-band decision.
param remediationLiveEnabled = false

param shopifyShop = 'grundens.com'
param shopifyClientId = ''
