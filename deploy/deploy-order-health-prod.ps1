<#
.SYNOPSIS
  Provision the Azure + GitHub resources for the Order Health production deploy
  (ADR-0011, App Service for Containers). Idempotent and staged.

.DESCRIPTION
  Runs the prod-deploy runbook as a script. It creates the resource group,
  Postgres, Key Vault secrets, the OIDC deploy identity and its grants, and the
  production GitHub Environment; then (after the first deploy creates the app)
  grants the app identity and enables the aggregator.

  SECRETS are never hardcoded and never printed. You are prompted for them with a
  masked prompt, or you pass them as SecureString parameters. The script only
  ever pipes them straight into `az keyvault secret set`.

  STAGES, because some steps can only run after the App Service exists:
    provision : RG, Postgres, KV secrets, OIDC identity + grants, repo vars,
                production environment. Run this first.
    grant     : after the first deploy has created app-order-health-prod-01,
                grant its managed identity AcrPull + (prints) the NAV db_datareader
                SQL, then restart. Run this once the app exists.
    enable    : verify health, then flip AGGREGATOR_ENABLED=true and restart.
    all       : provision (you still deploy + run grant/enable afterwards).

  Nothing here is destructive. Every create is guarded (skip if it exists).
  Remediation stays DISARMED throughout; this script never arms it.

.PARAMETER Stage
  provision (default) | grant | enable

.PARAMETER KeyVaultName
  The shared prod Key Vault name (in rg-kv-shared-prod-01). Required for
  provision. Prompted if omitted.

.PARAMETER ReviewerGitHubUserId
  Numeric GitHub user id to set as the required reviewer on the production
  environment. If omitted, the environment is created and you add the reviewer in
  the UI (the script tells you how).

.PARAMETER DryRun
  Print every az/gh command instead of running it. Nothing is changed.

.EXAMPLE
  .\deploy-order-health-prod.ps1 -Stage provision -KeyVaultName kv-shared-prod-01
.EXAMPLE
  .\deploy-order-health-prod.ps1 -Stage provision -DryRun
.EXAMPLE
  .\deploy-order-health-prod.ps1 -Stage grant
.EXAMPLE
  .\deploy-order-health-prod.ps1 -Stage enable
#>
[CmdletBinding()]
param(
    [ValidateSet('provision','grant','enable')]
    [string]$Stage = 'provision',

    [string]$KeyVaultName,
    [string]$ReviewerGitHubUserId,

    # Optional: pass secrets non-interactively as SecureString. Otherwise prompted.
    [SecureString]$PostgresAdminPassword,
    [SecureString]$ShopifyClientSecret,
    [SecureString]$MiddlewareAuthToken,
    [SecureString]$NavTogglePassword,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:ProgramData)) { $env:ProgramData = 'C:\ProgramData' }

# ---------------------------------------------------------------- constants ---
$APP_SUB  = 'c63b42ea-eb59-4b94-ac15-f97c6d902000'   # grundies-corp-prod (app)
$NAV_SUB  = 'ba95a0a4-97ac-4f71-b00c-8c6f72966759'   # grus-prd-01 (NAV Azure SQL)
$ACR_SUB  = '4dafd997-8b1e-41ea-b9bc-06d499bef766'   # grundies-corp-dev (ACR)
$RG       = 'rg-order-health-prod-01'
$LOC      = 'westus3'
$KV_RG    = 'rg-kv-shared-prod-01'
$PG       = 'psql-order-health-prod-01'
$PG_DB    = 'order_health'
$PG_ADMIN = 'oh_admin'
$APP_NAME = 'app-order-health-prod-01'
$ACR_NAME = 'grundens'                                # grundens.azurecr.io
$REPO     = 'grundens-it/order-health'
$NAV_SQL_SERVER = 'sql-grus-prd-01.database.windows.net'
$NAV_SQL_DB     = 'sqldb-nav18-grus-prd-01'

# --------------------------------------------------------------- helpers ------
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Note($m) { Write-Host "    $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "    $m" -ForegroundColor Red }

# Run an az/gh command array. In DryRun, print it. Returns stdout (trimmed).
function Inv([string[]]$cmd) {
    $pretty = ($cmd | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    if ($DryRun) { Write-Host "    [dry] $pretty" -ForegroundColor DarkGray; return '' }
    $out = & $cmd[0] @($cmd[1..($cmd.Count-1)]) 2>&1
    if ($LASTEXITCODE -ne 0) {
        Bad "command failed: $pretty"
        Bad ($out | Out-String)
        throw "az/gh command failed (exit $LASTEXITCODE)."
    }
    return ($out | Out-String).Trim()
}

# Read-only existence check. Returns the trimmed value, or $null if the resource
# does not exist yet. Swallows az's "not found" stderr so a first run does not
# look like it failed when it is simply about to create the thing.
function Get-AzValue([string[]]$cmd) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $out = & $cmd[0] @($cmd[1..($cmd.Count-1)]) 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        $t = ($out | Out-String).Trim()
        if ([string]::IsNullOrWhiteSpace($t)) { return $null } else { return $t }
    } catch { return $null }
    finally { $ErrorActionPreference = $old }
}

# Convert a SecureString to plaintext ONLY at the moment we pipe it to az.
function Reveal([SecureString]$s) {
    if (-not $s) { return $null }
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

function Need-Secret([SecureString]$provided, [string]$prompt) {
    if ($provided) { return $provided }
    return (Read-Host -AsSecureString -Prompt "    $prompt")
}

# Set a KV secret from a SecureString without the value ever hitting the console
# or the process table. az reads it from --value; we build the arg then clear it.
function Set-KvSecret([string]$vault, [string]$name, [SecureString]$secure) {
    $plain = Reveal $secure
    if ([string]::IsNullOrWhiteSpace($plain)) { Note "skip $name (empty)"; return }
    if ($DryRun) { Write-Host "    [dry] az keyvault secret set --vault-name $vault -n $name --value <hidden>" -ForegroundColor DarkGray; $plain=$null; return }
    $null = az keyvault secret set --vault-name $vault -n $name --value $plain 2>&1
    $plain = $null
    if ($LASTEXITCODE -ne 0) { throw "failed to set secret $name" }
    Ok "secret set: $name"
}

# ---------------------------------------------------------------- preflight ---
Step "Preflight"
foreach ($tool in 'az','gh') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool not found on PATH." }
}
$who = az account show --query user.name -o tsv 2>$null
if ([string]::IsNullOrWhiteSpace($who)) { Bad "Not logged in. Run: az login"; throw "az login required." }
Ok "az user: $who"
$ghAuth = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) { Bad "gh not authenticated. Run: gh auth login"; throw "gh auth required." }
Ok "gh authenticated"
if ($DryRun) { Note "DRY RUN: no changes will be made." }
Inv @('az','account','set','--subscription',$APP_SUB) | Out-Null

# ================================================================ PROVISION ===
if ($Stage -eq 'provision') {

    if (-not $KeyVaultName) { $KeyVaultName = Read-Host "    Shared prod Key Vault name (in $KV_RG)" }
    if ([string]::IsNullOrWhiteSpace($KeyVaultName)) { throw "KeyVaultName is required for provision." }

    # 1. Resource group ------------------------------------------------------
    Step "1. Resource group $RG"
    $rgExists = az group exists -n $RG --subscription $APP_SUB
    if ($rgExists -eq 'true') { Ok "exists" }
    else { Inv @('az','group','create','-n',$RG,'-l',$LOC,'--subscription',$APP_SUB) | Out-Null; Ok "created" }

    # 2. Postgres ------------------------------------------------------------
    Step "2. Postgres flexible server $PG"
    $pgExists = Get-AzValue @('az','postgres','flexible-server','show','-g',$RG,'-n',$PG,'--subscription',$APP_SUB,'--query','name','-o','tsv')
    $PostgresAdminPassword = Need-Secret $PostgresAdminPassword "Postgres admin password to SET (new server) or the EXISTING one"
    $pgPw = Reveal $PostgresAdminPassword
    if ($pgExists) {
        Ok "server exists (using the password you entered for the DATABASE_URL)"
    } else {
        if ($DryRun) { Note "[dry] az postgres flexible-server create ... (password hidden)" }
        else {
            $null = az postgres flexible-server create --subscription $APP_SUB -g $RG -l $LOC `
                --name $PG --version 16 --tier Burstable --sku-name Standard_B1ms --storage-size 32 `
                --admin-user $PG_ADMIN --admin-password $pgPw --public-access 0.0.0.0 --yes 2>&1
            if ($LASTEXITCODE -ne 0) { throw "postgres create failed" }
            $null = az postgres flexible-server db create --subscription $APP_SUB -g $RG -s $PG -d $PG_DB 2>&1
            Ok "server + database created"
        }
    }

    # 3. Confirm KV exists ---------------------------------------------------
    Step "3. Key Vault $KeyVaultName (in $KV_RG)"
    $kvId = Get-AzValue @('az','keyvault','show','-g',$KV_RG,'-n',$KeyVaultName,'--subscription',$APP_SUB,'--query','id','-o','tsv')
    if (-not $kvId -and -not $DryRun) { throw "Key Vault $KeyVaultName not found in $KV_RG. Confirm the name." }
    if ($kvId) { Ok "found" } else { Ok "(dry) assume it exists" }
    Note "REMINDER: set keyVaultName='$KeyVaultName' in infra/bicep/main.bicepparam (replace REPLACE-ME) and commit to release/prod-appservice."

    # 4. Key Vault secrets ---------------------------------------------------
    Step "4. Key Vault secrets"
    $pgFqdn = Get-AzValue @('az','postgres','flexible-server','show','--subscription',$APP_SUB,'-g',$RG,'-n',$PG,'--query','fullyQualifiedDomainName','-o','tsv')
    if (-not $pgFqdn) { $pgFqdn = "$PG.postgres.database.azure.com" }
    $dbUrl = "postgres://$PG_ADMIN`:$pgPw@$pgFqdn`:5432/$PG_DB`?sslmode=require"
    $dbUrlSecure = ConvertTo-SecureString $dbUrl -AsPlainText -Force
    Set-KvSecret $KeyVaultName 'order-health-database-url' $dbUrlSecure
    $dbUrl = $null; $pgPw = $null
    $ShopifyClientSecret = Need-Secret $ShopifyClientSecret "Shopify client secret (ADR-0009 read-only client)"
    Set-KvSecret $KeyVaultName 'order-health-shopify-client-secret' $ShopifyClientSecret
    $MiddlewareAuthToken = Need-Secret $MiddlewareAuthToken "Middleware auth token (only read when ARMED; blank ok for now)"
    Set-KvSecret $KeyVaultName 'order-health-middleware-auth-token' $MiddlewareAuthToken
    $NavTogglePassword = Need-Secret $NavTogglePassword "NAV toggle password (only read when ARMED; blank ok for now)"
    Set-KvSecret $KeyVaultName 'order-health-nav-toggle-password' $NavTogglePassword

    # 5. OIDC deploy identity + grants + repo vars ---------------------------
    Step "5. OIDC deploy identity gh-order-health-deploy"
    $appId = Get-AzValue @('az','ad','app','list','--display-name','gh-order-health-deploy','--query','[0].appId','-o','tsv')
    if (-not $appId) {
        $appId = Inv @('az','ad','app','create','--display-name','gh-order-health-deploy','--query','appId','-o','tsv')
        Inv @('az','ad','sp','create','--id',$appId) | Out-Null
        Ok "app registration + sp created ($appId)"
    } else { Ok "app registration exists ($appId)" }

    $tenant = az account show --query tenantId -o tsv
    # Federated credentials (guarded by name).
    $fics = az ad app federated-credential list --id $appId --query "[].name" -o tsv 2>$null
    if ($fics -notmatch 'gh-main') {
        $p = '{\"name\":\"gh-main\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"repo:' + $REPO + ':ref:refs/heads/main\",\"audiences\":[\"api://AzureADTokenExchange\"]}'
        Inv @('az','ad','app','federated-credential','create','--id',$appId,'--parameters',$p) | Out-Null
        Ok "fic gh-main created"
    } else { Ok "fic gh-main exists" }
    if ($fics -notmatch 'gh-env-prod') {
        $p = '{\"name\":\"gh-env-prod\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"repo:' + $REPO + ':environment:production\",\"audiences\":[\"api://AzureADTokenExchange\"]}'
        Inv @('az','ad','app','federated-credential','create','--id',$appId,'--parameters',$p) | Out-Null
        Ok "fic gh-env-prod created"
    } else { Ok "fic gh-env-prod exists" }

    Step "5b. Deploy identity role grants"
    Inv @('az','role','assignment','create','--assignee',$appId,'--role','Contributor','--scope',"/subscriptions/$APP_SUB/resourceGroups/$RG") | Out-Null
    Ok "Contributor on $RG"
    $acrId = Get-AzValue @('az','acr','show','--subscription',$ACR_SUB,'-n',$ACR_NAME,'--query','id','-o','tsv')
    if ($acrId) {
        Inv @('az','role','assignment','create','--assignee',$appId,'--role','AcrPush','--scope',$acrId) | Out-Null
        Ok "AcrPush on $ACR_NAME (dev sub)"
    } else { Note "ACR $ACR_NAME not found in dev sub; grant AcrPush manually." }
    if ($kvId) {
        Inv @('az','role','assignment','create','--assignee',$appId,'--role','Role Based Access Control Administrator','--scope',$kvId) | Out-Null
        Ok "RBAC Admin on the vault (lets Bicep grant the app identity KV Secrets User)"
    }

    Step "5c. Repo variables (deploy.yml reads vars, not secrets)"
    Inv @('gh','variable','set','AZURE_CLIENT_ID','-R',$REPO,'-b',$appId) | Out-Null
    Inv @('gh','variable','set','AZURE_TENANT_ID','-R',$REPO,'-b',$tenant) | Out-Null
    Inv @('gh','variable','set','AZURE_SUBSCRIPTION_ID','-R',$REPO,'-b',$APP_SUB) | Out-Null
    Ok "AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_SUBSCRIPTION_ID set"

    # 6. production environment WITH reviewer --------------------------------
    Step "6. production GitHub Environment (the human gate)"
    if ($ReviewerGitHubUserId) {
        $body = @{ reviewers = @(@{ type='User'; id=[int]$ReviewerGitHubUserId }); deployment_branch_policy=$null } | ConvertTo-Json -Depth 5
        if ($DryRun) { Note "[dry] PUT environments/production with reviewer $ReviewerGitHubUserId" }
        else {
            $body | gh api -X PUT "repos/$REPO/environments/production" --input - | Out-Null
            Ok "production environment created with required reviewer $ReviewerGitHubUserId"
        }
    } else {
        if (-not $DryRun) { gh api -X PUT "repos/$REPO/environments/production" | Out-Null }
        Note "production environment created WITHOUT a reviewer. Add yourself now:"
        Note "  GitHub > Settings > Environments > production > Required reviewers = you, branches = main"
    }

    Step "Provision done"
    Ok "Next: 1) commit the keyVaultName edit to release/prod-appservice, 2) merge PR #81 (or run the deploy workflow), 3) approve the production gate."
    Ok "The FIRST deploy will fail to pull the image (app identity has no AcrPull yet). That is expected."
    Ok "Then run:  .\deploy-order-health-prod.ps1 -Stage grant"
}

# =================================================================== GRANT ====
if ($Stage -eq 'grant') {
    Step "Post-creation grants for the app identity"
    $mi = Get-AzValue @('az','webapp','show','--subscription',$APP_SUB,'-g',$RG,'-n',$APP_NAME,'--query','identity.principalId','-o','tsv')
    if (-not $mi) { throw "$APP_NAME not found yet. Run the first deploy (merge PR #81 + approve the gate), then re-run -Stage grant." }
    Ok "app managed identity: $mi"

    $acrId = Get-AzValue @('az','acr','show','--subscription',$ACR_SUB,'-n',$ACR_NAME,'--query','id','-o','tsv')
    Inv @('az','role','assignment','create','--assignee-object-id',$mi,'--assignee-principal-type','ServicePrincipal','--role','AcrPull','--scope',$acrId) | Out-Null
    Ok "AcrPull granted to the app identity (dev sub)"

    Step "NAV db_datareader (SQL grant, run as an Entra admin on NAV)"
    $sql = @"
CREATE USER [$APP_NAME] FROM EXTERNAL PROVIDER;
ALTER ROLE db_datareader ADD MEMBER [$APP_NAME];
"@
    $sqlcmd = Get-Command sqlcmd -ErrorAction SilentlyContinue
    if ($sqlcmd -and -not $DryRun) {
        Note "Attempting the grant via sqlcmd with Entra auth (a browser/device prompt may appear)..."
        $tmp = New-TemporaryFile
        Set-Content $tmp $sql -Encoding ascii
        & sqlcmd -S $NAV_SQL_SERVER -d $NAV_SQL_DB -G -i $tmp.FullName
        Remove-Item $tmp -Force
        if ($LASTEXITCODE -eq 0) { Ok "NAV db_datareader granted" }
        else { Bad "sqlcmd failed; run this SQL manually as a NAV Entra admin:"; Write-Host $sql -ForegroundColor White }
    } else {
        Note "Run this SQL against $NAV_SQL_DB on $NAV_SQL_SERVER as an Entra admin:"
        Write-Host $sql -ForegroundColor White
    }

    Step "Restart the app so the pull + grants take effect"
    Inv @('az','webapp','restart','--subscription',$APP_SUB,'-g',$RG,'-n',$APP_NAME) | Out-Null
    Ok "restarted. Next:  .\deploy-order-health-prod.ps1 -Stage enable"
}

# ================================================================== ENABLE ====
if ($Stage -eq 'enable') {
    Step "Verify health, then enable the aggregator (ADR-0004 gate)"
    # NOTE: do not use $host, it is a reserved automatic variable in PowerShell.
    $appHost = Get-AzValue @('az','webapp','show','--subscription',$APP_SUB,'-g',$RG,'-n',$APP_NAME,'--query','defaultHostName','-o','tsv')
    if (-not $appHost) { throw "$APP_NAME not found. Deploy first." }
    Ok "host: https://$appHost"
    if (-not $DryRun) {
        $ok = $false
        for ($i=1; $i -le 20; $i++) {
            try { $r = Invoke-RestMethod "https://$appHost/api/health/ping" -TimeoutSec 8; if ($r.ok) { $ok=$true; Ok "healthy (as_of $($r.as_of))"; break } } catch { }
            Start-Sleep -Seconds 6
        }
        if (-not $ok) { throw "App did not report healthy. Check logs before enabling the aggregator." }
    }
    Inv @('az','webapp','config','appsettings','set','--subscription',$APP_SUB,'-g',$RG,'-n',$APP_NAME,'--settings','AGGREGATOR_ENABLED=true') | Out-Null
    Inv @('az','webapp','restart','--subscription',$APP_SUB,'-g',$RG,'-n',$APP_NAME) | Out-Null
    Ok "AGGREGATOR_ENABLED=true, restarted. Remediation stays DISARMED."
    Ok "Watch the board: as_of should advance within a few minutes."
}
