<#
.SYNOPSIS
  One-time BOOTSTRAP for the Order Health production deploy (ADR-0011, App Service
  for Containers). Only the genuinely non-pipeline steps live here; everything
  automatable now runs from the pipeline (push to main).

.DESCRIPTION
  What the PIPELINE owns now (deploy.yml + main.bicep), NOT this script:
    - the resource group (az group create, idempotent),
    - the Key Vault kv-order-health-prod-01 and the app-identity get/list access
      policy (created in Bicep),
    - Log Analytics, App Insights, the App Service + its settings,
    - the container image tag and the post-deploy health smoke.

  What stays here, because its origin is inherently a one-time secret or a
  cross-subscription privileged grant:
    provision : the OIDC deploy identity (app registration + federated creds),
                the deploy role grants (Contributor on the RG, AcrPush on the
                ACR), the three AZURE_* repo variables, and the production
                environment with you as reviewer. Also creates the RG so the
                Contributor scope exists before the first push. Zero prompts.
    grant     : after the first deploy created the app + the Bicep Key Vault,
                create Postgres (admin password generated, stored only in KV),
                seed the KV secret VALUES (DATABASE_URL etc.), grant the app
                identity AcrPull (cross-sub) and NAV db_datareader, then restart.
    enable    : verify health, then flip AGGREGATOR_ENABLED=true.

  Nothing here is destructive. Remediation stays DISARMED throughout.

.PARAMETER Stage
  provision (default) | grant | enable

.PARAMETER EnvFile
  Path to a backend/.env holding SHOPIFY_CLIENT_SECRET etc. Secrets are read at
  runtime on your machine and piped straight to Key Vault; never printed.

.PARAMETER DryRun
  Print every az/gh command instead of running it. Nothing is changed.

.EXAMPLE
  .\bootstrap-order-health-prod.ps1                  # provision (identity), zero input
.EXAMPLE
  .\bootstrap-order-health-prod.ps1 -Stage grant     # after the first deploy
.EXAMPLE
  .\bootstrap-order-health-prod.ps1 -Stage enable
#>
[CmdletBinding()]
param(
    [ValidateSet('provision','grant','enable')]
    [string]$Stage = 'provision',
    [string]$EnvFile = 'D:\src\Claude\oh-exec-remediation\backend\.env',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:ProgramData)) { $env:ProgramData = 'C:\ProgramData' }

# ---------------------------------------------------------------- constants ---
$APP_SUB  = 'c63b42ea-eb59-4b94-ac15-f97c6d902000'   # grundies-corp-prod (app)
$ACR_SUB  = '4dafd997-8b1e-41ea-b9bc-06d499bef766'   # grundies-corp-dev (ACR)
$RG       = 'rg-order-health-prod-01'
$LOC      = 'westus3'
$PG       = 'psql-order-health-prod-01'
$PG_DB    = 'order_health'
$PG_ADMIN = 'oh_admin'
$KV_NAME  = 'kv-order-health-prod-01'                 # CREATED BY BICEP; seeded here
$APP_NAME = 'app-order-health-prod-01'
$ACR_NAME = 'grundens'
$REPO     = 'grundens-it/order-health'
$NAV_SQL_SERVER = 'sql-grus-prd-01.database.windows.net'
$NAV_SQL_DB     = 'sqldb-nav18-grus-prd-01'

# --------------------------------------------------------------- helpers ------
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Note($m) { Write-Host "    $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "    $m" -ForegroundColor Red }

function Inv([string[]]$cmd) {
    $pretty = ($cmd | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    if ($DryRun) { Write-Host "    [dry] $pretty" -ForegroundColor DarkGray; return '' }
    $out = & $cmd[0] @($cmd[1..($cmd.Count-1)]) 2>&1
    if ($LASTEXITCODE -ne 0) { Bad "command failed: $pretty"; Bad ($out | Out-String); throw "az/gh failed (exit $LASTEXITCODE)." }
    return ($out | Out-String).Trim()
}

# Read-only existence check. Returns value or $null, swallowing not-found stderr.
function Get-AzValue([string[]]$cmd) {
    $old = $ErrorActionPreference; $ErrorActionPreference = 'SilentlyContinue'
    try {
        $out = & $cmd[0] @($cmd[1..($cmd.Count-1)]) 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        $t = ($out | Out-String).Trim()
        if ([string]::IsNullOrWhiteSpace($t)) { return $null } else { return $t }
    } catch { return $null } finally { $ErrorActionPreference = $old }
}

# Pull a KEY=value from an env file WITHOUT surfacing the value. Returns '' if absent.
function Read-EnvValue([string]$path, [string]$key) {
    if (-not (Test-Path $path)) { return '' }
    $line = Select-String -Path $path -Pattern "^\s*$key\s*=" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $line) { return '' }
    return ($line.Line -replace "^\s*$key\s*=\s*", '').Trim().Trim('"')
}

# Generate an Azure-complexity-safe password (upper, lower, digit, symbol; 28 chars).
function New-StrongPassword {
    $U='ABCDEFGHIJKLMNOPQRSTUVWXYZ'; $L='abcdefghijklmnopqrstuvwxyz'; $D='0123456789'; $S='-_.~'
    $all = ($U+$L+$D+$S).ToCharArray()
    $chars = @($U[(Get-Random -Max $U.Length)], $L[(Get-Random -Max $L.Length)], $D[(Get-Random -Max $D.Length)], $S[(Get-Random -Max $S.Length)])
    $chars += 1..24 | ForEach-Object { $all[(Get-Random -Max $all.Length)] }
    -join ($chars | Sort-Object { Get-Random })
}

# Set a KV secret from a plaintext string (already in memory) without echoing it.
function Set-KvSecretPlain([string]$vault, [string]$name, [string]$value) {
    if ([string]::IsNullOrWhiteSpace($value)) { Note "skip $name (empty; set later before arming)"; return }
    if ($DryRun) { Write-Host "    [dry] az keyvault secret set --vault-name $vault -n $name --value <hidden>" -ForegroundColor DarkGray; return }
    $null = az keyvault secret set --vault-name $vault -n $name --value $value 2>&1
    if ($LASTEXITCODE -ne 0) { throw "failed to set secret $name" }
    Ok "secret set: $name"
}

# ---------------------------------------------------------------- preflight ---
Step "Preflight"
foreach ($tool in 'az','gh') { if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool not found on PATH." } }
$who = az account show --query user.name -o tsv 2>$null
if ([string]::IsNullOrWhiteSpace($who)) { Bad "Not logged in. Run: az login"; throw "az login required." }
Ok "az user: $who"
$null = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) { Bad "gh not authenticated. Run: gh auth login"; throw "gh auth required." }
Ok "gh authenticated"
if ($DryRun) { Note "DRY RUN: no changes will be made." }
Inv @('az','account','set','--subscription',$APP_SUB) | Out-Null

# ================================================================ PROVISION ===
# Identity + repo wiring only. No Postgres, no Key Vault, no secrets here: the
# pipeline creates the RG and (via Bicep) the vault + app on the first push.
if ($Stage -eq 'provision') {

    # 1. Resource group (so the Contributor scope exists before the first push;
    #    the pipeline also creates it idempotently). ------------------------
    Step "1. Resource group $RG"
    if ((az group exists -n $RG --subscription $APP_SUB) -eq 'true') { Ok "exists" }
    else { Inv @('az','group','create','-n',$RG,'-l',$LOC,'--subscription',$APP_SUB) | Out-Null; Ok "created" }

    # 2. OIDC deploy identity + federated credentials -----------------------
    Step "2. OIDC deploy identity gh-order-health-deploy"
    $appId = Get-AzValue @('az','ad','app','list','--display-name','gh-order-health-deploy','--query','[0].appId','-o','tsv')
    if (-not $appId) {
        $appId = Inv @('az','ad','app','create','--display-name','gh-order-health-deploy','--query','appId','-o','tsv')
        Inv @('az','ad','sp','create','--id',$appId) | Out-Null
        Ok "app registration + sp created ($appId)"
    } else { Ok "exists ($appId)" }
    $tenant = az account show --query tenantId -o tsv
    # Out-String forces a scalar: `-notmatch` against an empty ARRAY returns an
    # empty array (falsy), which would wrongly take the "exists" branch on a
    # brand-new app that has NO federated credentials yet. A string behaves.
    $fics = (az ad app federated-credential list --id $appId --query "[].name" -o tsv 2>$null | Out-String)
    if ($fics -notmatch 'gh-main') {
        $p = '{\"name\":\"gh-main\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"repo:' + $REPO + ':ref:refs/heads/main\",\"audiences\":[\"api://AzureADTokenExchange\"]}'
        Inv @('az','ad','app','federated-credential','create','--id',$appId,'--parameters',$p) | Out-Null; Ok "fic gh-main"
    } else { Ok "fic gh-main exists" }
    if ($fics -notmatch 'gh-env-prod') {
        $p = '{\"name\":\"gh-env-prod\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"repo:' + $REPO + ':environment:production\",\"audiences\":[\"api://AzureADTokenExchange\"]}'
        Inv @('az','ad','app','federated-credential','create','--id',$appId,'--parameters',$p) | Out-Null; Ok "fic gh-env-prod"
    } else { Ok "fic gh-env-prod exists" }

    # 3. Deploy identity role grants ----------------------------------------
    Step "3. Deploy identity role grants"
    Inv @('az','role','assignment','create','--assignee',$appId,'--role','Contributor','--scope',"/subscriptions/$APP_SUB/resourceGroups/$RG") | Out-Null
    Ok "Contributor on $RG (lets the pipeline create the vault + app via Bicep)"
    $acrId = Get-AzValue @('az','acr','show','--subscription',$ACR_SUB,'-n',$ACR_NAME,'--query','id','-o','tsv')
    if ($acrId) { Inv @('az','role','assignment','create','--assignee',$appId,'--role','AcrPush','--scope',$acrId) | Out-Null; Ok "AcrPush on $ACR_NAME (dev sub)" }
    else { Note "ACR $ACR_NAME not found; grant AcrPush manually." }

    # 4. Repo variables -----------------------------------------------------
    Step "4. Repo variables"
    Inv @('gh','variable','set','AZURE_CLIENT_ID','-R',$REPO,'-b',$appId) | Out-Null
    Inv @('gh','variable','set','AZURE_TENANT_ID','-R',$REPO,'-b',$tenant) | Out-Null
    Inv @('gh','variable','set','AZURE_SUBSCRIPTION_ID','-R',$REPO,'-b',$APP_SUB) | Out-Null
    Ok "AZURE_CLIENT_ID / TENANT_ID / SUBSCRIPTION_ID set"

    # 5. production environment WITH you as reviewer (auto) -----------------
    Step "5. production GitHub Environment (auto reviewer = you)"
    $myId = gh api user --jq '.id' 2>$null
    if ($myId -and -not $DryRun) {
        $body = @{ reviewers=@(@{ type='User'; id=[int]$myId }); deployment_branch_policy=$null } | ConvertTo-Json -Depth 5
        $body | gh api -X PUT "repos/$REPO/environments/production" --input - | Out-Null
        Ok "production environment created; required reviewer = you ($myId)"
    } elseif ($DryRun) { Note "[dry] PUT environments/production with reviewer = your gh id" }
    else { if (-not $DryRun) { gh api -X PUT "repos/$REPO/environments/production" | Out-Null }; Note "could not resolve your gh id; add yourself as reviewer in the UI." }

    Step "Provision done. Zero manual entry."
    Ok "Now: merge to main (or run the deploy workflow). Approve the production gate."
    Ok "The pipeline creates the RG, the Key Vault (+ app access policy), and the App Service."
    Ok "The FIRST deploy will fail to pull the image (app identity has no AcrPull yet). Expected."
    Ok "Then:  .\bootstrap-order-health-prod.ps1 -Stage grant"
}

# =================================================================== GRANT ====
# Runs after the first deploy created the app + the Bicep-created Key Vault.
# Creates Postgres (its admin password is inherently a one-time secret), seeds
# the KV secret VALUES, and makes the two cross-subscription / data-plane grants
# the pipeline deliberately does not: AcrPull (cross-sub) and NAV db_datareader.
if ($Stage -eq 'grant') {
    Step "Post-creation bootstrap for the app identity + data plane"
    $mi = Get-AzValue @('az','webapp','show','--subscription',$APP_SUB,'-g',$RG,'-n',$APP_NAME,'--query','identity.principalId','-o','tsv')
    if (-not $mi) { throw "$APP_NAME not found yet. Run the first deploy (merge to main + approve the gate), then re-run -Stage grant." }
    Ok "app managed identity: $mi"

    # 1. Postgres (admin password auto-generated, stored only in Key Vault) --
    Step "1. Postgres flexible server $PG"
    $pgExists = Get-AzValue @('az','postgres','flexible-server','show','-g',$RG,'-n',$PG,'--subscription',$APP_SUB,'--query','name','-o','tsv')
    $pgPw = New-StrongPassword
    if ($pgExists) {
        Note "server already exists. Rotating the admin password so the stored DATABASE_URL is valid..."
        if (-not $DryRun) { $null = az postgres flexible-server update --subscription $APP_SUB -g $RG -n $PG --admin-password $pgPw 2>&1 }
        else { Note "[dry] az postgres flexible-server update ... (password hidden)" }
        Ok "password rotated"
    } else {
        if ($DryRun) { Note "[dry] az postgres flexible-server create ... (password auto-generated, hidden)" }
        else {
            $null = az postgres flexible-server create --subscription $APP_SUB -g $RG -l $LOC --name $PG --version 16 `
                --tier Burstable --sku-name Standard_B1ms --storage-size 32 `
                --admin-user $PG_ADMIN --admin-password $pgPw --public-access 0.0.0.0 --yes 2>&1
            if ($LASTEXITCODE -ne 0) { throw "postgres create failed" }
            $null = az postgres flexible-server db create --subscription $APP_SUB -g $RG -s $PG -d $PG_DB 2>&1
            Ok "server + database created (admin password generated, stored only in Key Vault)"
        }
    }

    # 2. Grant yourself set-secret on the Bicep-created vault, then seed the
    #    secret VALUES. The vault ships with only the app-identity get/list
    #    policy (from Bicep), so add a set policy for yourself first. ---------
    Step "2. Key Vault secret VALUES ($KV_NAME, created by Bicep)"
    $meObj = Get-AzValue @('az','ad','signed-in-user','show','--query','id','-o','tsv')
    if ($meObj) { Inv @('az','keyvault','set-policy','--subscription',$APP_SUB,'-n',$KV_NAME,'--object-id',$meObj,'--secret-permissions','set','get','list') | Out-Null; Ok "you can set secrets on $KV_NAME" }
    else { Note "could not resolve your object id; ensure you have set-secret on $KV_NAME." }

    $pgFqdn = Get-AzValue @('az','postgres','flexible-server','show','--subscription',$APP_SUB,'-g',$RG,'-n',$PG,'--query','fullyQualifiedDomainName','-o','tsv')
    if (-not $pgFqdn) { $pgFqdn = "$PG.postgres.database.azure.com" }
    $dbUrl = "postgres://$PG_ADMIN`:$pgPw@$pgFqdn`:5432/$PG_DB`?sslmode=require"
    Set-KvSecretPlain $KV_NAME 'order-health-database-url' $dbUrl
    $dbUrl = $null; $pgPw = $null

    if (Test-Path $EnvFile) { Ok "sourcing app secrets from $EnvFile" } else { Note "env file not found at $EnvFile; secrets left empty (set before arming)." }
    $shopify = Read-EnvValue $EnvFile 'SHOPIFY_CLIENT_SECRET'
    if (-not $shopify) { Note "SHOPIFY_CLIENT_SECRET not in env; enter it (or leave blank to set later):"; $sec = Read-Host -AsSecureString "    Shopify client secret"; $shopify = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)) }
    Set-KvSecretPlain $KV_NAME 'order-health-shopify-client-secret' $shopify; $shopify = $null
    Set-KvSecretPlain $KV_NAME 'order-health-middleware-auth-token' (Read-EnvValue $EnvFile 'MIDDLEWARE_AUTH_TOKEN')
    Set-KvSecretPlain $KV_NAME 'order-health-nav-toggle-password'   (Read-EnvValue $EnvFile 'NAV_TOGGLE_PASSWORD')

    # 3. AcrPull for the app identity (cross-subscription: ACR in dev sub) ----
    #    Kept in bootstrap: this is a role assignment in the DEV subscription,
    #    which the pipeline's deploy identity has no rights to make. See the PR.
    Step "3. AcrPull for the app identity (dev sub)"
    $acrId = Get-AzValue @('az','acr','show','--subscription',$ACR_SUB,'-n',$ACR_NAME,'--query','id','-o','tsv')
    Inv @('az','role','assignment','create','--assignee-object-id',$mi,'--assignee-principal-type','ServicePrincipal','--role','AcrPull','--scope',$acrId) | Out-Null
    Ok "AcrPull granted"

    # 4. NAV db_datareader (SQL grant, run as an Entra admin on NAV) ----------
    Step "4. NAV db_datareader (SQL grant, run as an Entra admin on NAV)"
    $sql = "CREATE USER [$APP_NAME] FROM EXTERNAL PROVIDER;`nALTER ROLE db_datareader ADD MEMBER [$APP_NAME];"
    $sqlcmd = Get-Command sqlcmd -ErrorAction SilentlyContinue
    if ($sqlcmd -and -not $DryRun) {
        Note "Attempting via sqlcmd with Entra auth (a device/browser prompt may appear)..."
        $tmp = New-TemporaryFile; Set-Content $tmp $sql -Encoding ascii
        & sqlcmd -S $NAV_SQL_SERVER -d $NAV_SQL_DB -G -i $tmp.FullName
        Remove-Item $tmp -Force
        if ($LASTEXITCODE -eq 0) { Ok "NAV db_datareader granted" } else { Bad "sqlcmd failed; run this SQL as a NAV Entra admin:"; Write-Host $sql -ForegroundColor White }
    } else { Note "Run this SQL against $NAV_SQL_DB on $NAV_SQL_SERVER as an Entra admin:"; Write-Host $sql -ForegroundColor White }

    # 5. Restart so the app picks up its secrets + pullable image ------------
    Step "5. Restart the app"
    Inv @('az','webapp','restart','--subscription',$APP_SUB,'-g',$RG,'-n',$APP_NAME) | Out-Null
    Ok "restarted. On boot the backend applies db/migrations against Postgres. Next:  .\bootstrap-order-health-prod.ps1 -Stage enable"
}

# ================================================================== ENABLE ====
if ($Stage -eq 'enable') {
    Step "Verify health, then enable the aggregator (ADR-0004 gate)"
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
}
