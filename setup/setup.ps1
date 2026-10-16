<#
.SYNOPSIS
  One-command Google Cloud setup for dockeriser. Safe to re-run: every step checks before it acts.

.DESCRIPTION
  Signs you in to Google (browser), picks or creates the project, links billing, turns on the APIs,
  creates the image repo, the two storage buckets and the "dockeriser" service account with its
  permissions, sets a budget alert, lets dockeriser sign in as that account (browser, once), saves
  %USERPROFILE%\.dockeriser\config.json, then runs `dockeriser login` to check everything.

  Without -Project it asks which project to use. With -Project it never asks (for scripts and agents).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup\setup.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup\setup.ps1 -Project my-project-id -Budget 10
#>
[CmdletBinding()]
param(
  [string]$Project,
  [string]$Region = 'northamerica-northeast2',
  [string]$Repo = 'docker-images',
  [string]$BillingAccount,
  [int]$Budget = 5,
  [switch]$CreateKey
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ConfigDir = Join-Path $env:USERPROFILE '.dockeriser'
$ConfigFile = Join-Path $ConfigDir 'config.json'
$KeyPath = Join-Path $ConfigDir 'key.json'
$ProjectIdPattern = '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
$Check = [char]0x2714
$Cross = [char]0x2716

function Write-Ok([string]$Text) { Write-Host "$Check $Text" -ForegroundColor Green }
function Write-Skip([string]$Text) { Write-Host "  skipped: $Text (already done)" -ForegroundColor DarkGray }
function Write-Fail([string]$Text) { Write-Host "$Cross $Text" -ForegroundColor Red }
function Stop-Setup([string]$Text) { Write-Fail $Text; exit 1 }

# Plain functions with $args, so gcloud flags like --project pass straight through.
# Invoke-Gcloud stops the script on failure; Test-Gcloud is a quiet probe that never throws.
function Invoke-Gcloud {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & gcloud @args 2>&1; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $previous }
  if ($code -ne 0) {
    $detail = (($out | ForEach-Object { "$_" } | Where-Object { $_.Trim() }) | Select-Object -Last 3) -join ' '
    throw "gcloud $($args[0]) $($args[1]) failed: $detail"
  }
}
# Interactive gcloud commands (browser sign-ins) keep the console.
function Invoke-GcloudInteractive {
  & gcloud @args
  if ($LASTEXITCODE -ne 0) { throw "gcloud $($args[0]) $($args[1]) did not finish" }
}
function Test-Gcloud {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & gcloud @args 2>$null
    return @{ Ok = ($LASTEXITCODE -eq 0); Out = (($out | ForEach-Object { "$_" }) -join "`n").Trim() }
  } finally {
    $ErrorActionPreference = $previous
  }
}

# New service accounts take a few seconds to be visible to IAM, so permission grants retry.
function Invoke-WithRetry([scriptblock]$Block, [int]$Attempts = 6) {
  for ($i = 1; $i -le $Attempts; $i++) {
    try { & $Block; return } catch {
      if ($i -eq $Attempts) { throw }
      Start-Sleep -Seconds (5 * $i)
    }
  }
}

# True when an IAM policy (JSON from get-iam-policy --format=json) already has role -> member.
function Test-Binding([string]$PolicyJson, [string]$Role, [string]$Member) {
  if (-not $PolicyJson) { return $false }
  $policy = $PolicyJson | ConvertFrom-Json
  foreach ($b in @($policy.bindings)) {
    if ($b.role -eq $Role -and @($b.members) -contains $Member -and -not $b.condition) { return $true }
  }
  return $false
}

# Write UTF-8 without a BOM (Windows PowerShell 5.1's -Encoding utf8 adds one).
function Write-Utf8File([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Save-Config {
  New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
  $config = [ordered]@{ project = $Project; region = $Region; repo = $Repo; serviceAccount = "dockeriser@$Project.iam.gserviceaccount.com" }
  Write-Utf8File $ConfigFile (($config | ConvertTo-Json) + "`n")
}

function Read-ProjectId {
  while ($true) {
    $id = (Read-Host 'Project ID').Trim().ToLower()
    if ($id -match $ProjectIdPattern) { return $id }
    Write-Host '  A project ID is 6-30 characters: lowercase letters, digits and hyphens, starting with a letter.' -ForegroundColor Yellow
  }
}

# Ask which project to use (only when -Project was not given).
function Select-Project {
  $saved = $null
  if (Test-Path $ConfigFile) {
    try { $saved = ((Get-Content $ConfigFile -Raw) | ConvertFrom-Json).project } catch { }
  }
  if ($saved) {
    $answer = Read-Host "Use project $saved? [Y/n]"
    if ($answer -eq '' -or $answer -match '^[Yy]') { return $saved }
  }
  $projects = @()
  $list = Test-Gcloud projects list '--format=value(projectId,name)' '--sort-by=projectId'
  if ($list.Ok -and $list.Out) {
    $projects = @($list.Out -split "`n" | Where-Object { $_.Trim() } | ForEach-Object {
      $parts = $_ -split "`t", 2
      [pscustomobject]@{ Id = $parts[0].Trim(); Name = $(if ($parts.Count -gt 1) { $parts[1].Trim() } else { '' }) }
    })
  }
  if ($projects.Count -gt 0) {
    Write-Host 'Which Google Cloud project should dockeriser use?'
    for ($i = 0; $i -lt $projects.Count; $i++) { Write-Host ("  {0}) {1}  {2}" -f ($i + 1), $projects[$i].Id, $projects[$i].Name) }
    Write-Host '  N) Create a new project'
    while ($true) {
      $pick = (Read-Host 'Choose a number or N').Trim()
      if ($pick -match '^[Nn]$') { break }
      $n = 0
      if ([int]::TryParse($pick, [ref]$n) -and $n -ge 1 -and $n -le $projects.Count) { return $projects[$n - 1].Id }
    }
  } else {
    Write-Host 'You have no Google Cloud projects yet, so let''s make one.'
  }
  Write-Host 'Opening the "create project" page in your browser. Either create it there and type its ID here,'
  Write-Host 'or just type a new ID (e.g. my-builds-123) and this script will create it for you.'
  try { Start-Process 'https://console.cloud.google.com/projectcreate' } catch { }
  return Read-ProjectId
}

try {
  # ---------------------------------------------------------------------- 1. gcloud + sign-in
  if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    Stop-Setup 'The Google Cloud tool (gcloud) is not installed. Run:  winget install Google.CloudSDK   then open a new terminal and run this script again.'
  }
  $account = (Test-Gcloud auth list '--filter=status:ACTIVE' '--format=value(account)').Out
  if ($account) {
    Write-Skip "signed in to Google as $account"
  } else {
    Write-Host 'Signing in to Google: a browser window opens. Pick your account, then come back here.'
    Invoke-GcloudInteractive auth login
    $account = (Test-Gcloud auth list '--filter=status:ACTIVE' '--format=value(account)').Out
    if (-not $account) { Stop-Setup 'Google sign-in did not finish. Run this script again.' }
    Write-Ok "signed in to Google as $account"
  }

  # ---------------------------------------------------------------------- 2. project
  if (-not $Project) { $Project = Select-Project }
  $Project = $Project.Trim().ToLower()
  if ($Project -notmatch $ProjectIdPattern) {
    Stop-Setup "`"$Project`" is not a valid project ID (6-30 characters: lowercase letters, digits, hyphens; starts with a letter)."
  }
  $SaEmail = "dockeriser@$Project.iam.gserviceaccount.com"
  $SrcBucket = "gs://$Project-dockeriser-src"
  $LogsBucket = "gs://$Project-dockeriser-logs"

  if ((Test-Gcloud projects describe $Project '--format=value(projectId)').Ok) {
    Write-Skip "project $Project exists"
  } else {
    Invoke-Gcloud projects create $Project --name $Project
    Write-Ok "created project $Project"
  }
  Save-Config

  # ---------------------------------------------------------------------- 3. billing
  $billingEnabled = (Test-Gcloud billing projects describe $Project '--format=value(billingEnabled)').Out
  if ($billingEnabled -eq 'True') {
    Write-Skip 'billing is linked'
  } else {
    if (-not $BillingAccount) {
      $accounts = @((Test-Gcloud billing accounts list '--filter=open=true' '--format=value(name,displayName)').Out -split "`n" | Where-Object { $_.Trim() })
      if ($accounts.Count -eq 0) {
        Stop-Setup "You have no billing account yet. Create one (pay-as-you-go; the free tier still applies) at https://console.cloud.google.com/billing/create then run this script again."
      }
      if ($accounts.Count -gt 1) {
        Write-Fail 'You have more than one billing account. Pick one and run again with -BillingAccount:'
        foreach ($a in $accounts) { Write-Host "    $($a -replace "`t", '   ')" }
        $first = ($accounts[0] -split "`t")[0] -replace '^billingAccounts/', ''
        Write-Host ''
        Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Project $Project -BillingAccount $first"
        exit 1
      }
      $BillingAccount = ($accounts[0] -split "`t")[0]
    }
    $BillingAccount = $BillingAccount -replace '^billingAccounts/', ''
    Invoke-Gcloud billing projects link $Project --billing-account $BillingAccount
    Write-Ok "linked billing account $BillingAccount"
  }

  # ---------------------------------------------------------------------- 4. APIs
  $apis = @('cloudbuild.googleapis.com', 'artifactregistry.googleapis.com', 'storage.googleapis.com', 'iam.googleapis.com',
    'iamcredentials.googleapis.com', 'logging.googleapis.com', 'serviceusage.googleapis.com', 'billingbudgets.googleapis.com')
  $enabled = (Test-Gcloud services list --enabled --project $Project '--format=value(config.name)').Out -split "`n"
  $missing = @($apis | Where-Object { $enabled -notcontains $_ })
  if ($missing.Count -gt 0) {
    Invoke-Gcloud services enable @missing --project $Project
    Write-Ok "turned on $($missing.Count) Google APIs"
  } else {
    Write-Skip 'Google APIs are on'
  }

  # ---------------------------------------------------------------------- 5. service account
  if ((Test-Gcloud iam service-accounts describe $SaEmail --project $Project).Ok) {
    Write-Skip "service account $SaEmail exists"
  } else {
    Invoke-Gcloud iam service-accounts create dockeriser --project $Project --display-name 'dockeriser (Cloud Build submitter and runner)' | Out-Null
    Write-Ok "created service account $SaEmail"
  }

  # ---------------------------------------------------------------------- 6. image repo
  if ((Test-Gcloud artifacts repositories describe $Repo --location $Region --project $Project).Ok) {
    Write-Skip "image repo $Repo exists"
  } else {
    Invoke-Gcloud artifacts repositories create $Repo --repository-format=docker --location $Region --project $Project --description 'Images built by dockeriser'
    Write-Ok "created image repo $Region-docker.pkg.dev/$Project/$Repo"
  }
  # A Keep rule alone deletes nothing, so pair it with a Delete rule: anything older than a day
  # goes, except the 10 newest versions of each image.
  $policyFile = Join-Path $env:TEMP 'dockeriser-cleanup-policy.json'
  Write-Utf8File $policyFile @'
[
  { "name": "keep-10-most-recent", "action": { "type": "Keep" }, "mostRecentVersions": { "keepCount": 10 } },
  { "name": "delete-older-than-1d", "action": { "type": "Delete" }, "condition": { "tagState": "any", "olderThan": "1d" } }
]
'@
  $cleanup = Test-Gcloud artifacts repositories set-cleanup-policies $Repo --location $Region --project $Project --policy $policyFile --no-dry-run --quiet
  Remove-Item $policyFile -Force
  if (-not $cleanup.Ok) { throw 'could not set the image cleanup policy' }
  Write-Ok 'image cleanup set (keeps the 10 newest versions of each image)'

  # ---------------------------------------------------------------------- 7. buckets
  foreach ($pair in @(@($SrcBucket, 1), @($LogsBucket, 30))) {
    $bucket = $pair[0]; $days = $pair[1]
    if ((Test-Gcloud storage buckets describe $bucket --project $Project).Ok) {
      Invoke-Gcloud storage buckets update $bucket --uniform-bucket-level-access --public-access-prevention --quiet
      Write-Skip "bucket $bucket exists"
    } else {
      Invoke-Gcloud storage buckets create $bucket --project $Project --location $Region --uniform-bucket-level-access --public-access-prevention --quiet
      Write-Ok "created private bucket $bucket"
    }
    $lifecycleFile = Join-Path $env:TEMP 'dockeriser-lifecycle.json'
    Write-Utf8File $lifecycleFile "{ `"rule`": [ { `"action`": { `"type`": `"Delete`" }, `"condition`": { `"age`": $days } } ] }"
    $lifecycle = Test-Gcloud storage buckets update $bucket "--lifecycle-file=$lifecycleFile" --quiet
    Remove-Item $lifecycleFile -Force
    if (-not $lifecycle.Ok) { throw "could not set auto-delete on $bucket" }
  }
  Write-Ok 'buckets auto-delete old files (uploads after 1 day, logs after 30)'

  # ---------------------------------------------------------------------- 8. permissions
  $member = "serviceAccount:$SaEmail"
  $granted = 0
  $projectPolicy = (Test-Gcloud projects get-iam-policy $Project --format=json).Out
  foreach ($role in @('roles/cloudbuild.builds.editor', 'roles/logging.logWriter', 'roles/serviceusage.serviceUsageConsumer')) {
    if (-not (Test-Binding $projectPolicy $role $member)) {
      Invoke-WithRetry { Invoke-Gcloud projects add-iam-policy-binding $Project --member $member --role $role --condition=None --quiet }
      $granted++
    }
  }
  $repoPolicy = (Test-Gcloud artifacts repositories get-iam-policy $Repo --location $Region --project $Project --format=json).Out
  if (-not (Test-Binding $repoPolicy 'roles/artifactregistry.writer' $member)) {
    Invoke-WithRetry { Invoke-Gcloud artifacts repositories add-iam-policy-binding $Repo --location $Region --project $Project --member $member --role roles/artifactregistry.writer --quiet }
    $granted++
  }
  foreach ($pair in @(@($SrcBucket, 'roles/storage.objectAdmin'), @($LogsBucket, 'roles/storage.admin'))) {
    $bucket = $pair[0]; $role = $pair[1]
    $bucketPolicy = (Test-Gcloud storage buckets get-iam-policy $bucket --format=json).Out
    if (-not (Test-Binding $bucketPolicy $role $member)) {
      Invoke-WithRetry { Invoke-Gcloud storage buckets add-iam-policy-binding $bucket --member $member --role $role --quiet }
      $granted++
    }
  }
  $saPolicy = (Test-Gcloud iam service-accounts get-iam-policy $SaEmail --project $Project --format=json).Out
  $saGrants = @(, @($member, 'roles/iam.serviceAccountUser'))
  if ($account -notlike '*.gserviceaccount.com') { $saGrants += , @("user:$account", 'roles/iam.serviceAccountTokenCreator') }
  foreach ($pair in $saGrants) {
    $who = $pair[0]; $role = $pair[1]
    if (-not (Test-Binding $saPolicy $role $who)) {
      Invoke-WithRetry { Invoke-Gcloud iam service-accounts add-iam-policy-binding $SaEmail --project $Project --member $who --role $role --quiet }
      $granted++
    }
  }
  if ($granted -gt 0) { Write-Ok "granted $granted permission(s) to the dockeriser account" } else { Write-Skip 'permissions are in place' }

  # ---------------------------------------------------------------------- 9. budget alert
  if ($Budget -gt 0) {
    $billingName = (Test-Gcloud billing projects describe $Project '--format=value(billingAccountName)').Out -replace '^billingAccounts/', ''
    $budgets = Test-Gcloud billing budgets list "--billing-account=$billingName" --billing-project $Project '--format=value(displayName)'
    if ($budgets.Ok -and (@($budgets.Out -split "`n") -contains 'dockeriser')) {
      Write-Skip 'budget alert "dockeriser" exists'
    } else {
      $created = Test-Gcloud billing budgets create "--billing-account=$billingName" --billing-project $Project --display-name=dockeriser `
        "--budget-amount=$Budget" "--filter-projects=projects/$Project" `
        --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
      if ($created.Ok) { Write-Ok "budget alert set: emails at 50%, 90% and 100% of $Budget a month" }
      else { Write-Fail "could not create the budget alert (you may need Billing Account Administrator). Set one by hand: https://console.cloud.google.com/billing/budgets" }
    }
  }

  # ---------------------------------------------------------------------- 10. sign-in for dockeriser
  if ($CreateKey) {
    if (Test-Path $KeyPath) { Write-Skip "key file $KeyPath exists" }
    else {
      Invoke-Gcloud iam service-accounts keys create $KeyPath --iam-account $SaEmail --project $Project
      Write-Ok "saved a key file at $KeyPath (keep it private)"
    }
  } else {
    $adcFile = Join-Path $env:APPDATA 'gcloud\application_default_credentials.json'
    $adcOk = $false
    if (Test-Path $adcFile) {
      try {
        $adc = (Get-Content $adcFile -Raw) | ConvertFrom-Json
        $adcOk = ($adc.type -eq 'impersonated_service_account') -and ("$($adc.service_account_impersonation_url)" -like "*$SaEmail*")
      } catch { }
    }
    if ($adcOk) {
      Write-Skip "dockeriser signs in as $SaEmail"
    } else {
      Write-Host 'One more browser sign-in: this lets dockeriser act as its build account.'
      Invoke-GcloudInteractive auth application-default login "--impersonate-service-account=$SaEmail"
      Write-Ok "dockeriser signs in as $SaEmail"
    }
  }
  Save-Config
  Write-Ok "saved settings to $ConfigFile"

  # ---------------------------------------------------------------------- 11. check
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Stop-Setup 'Node.js is not installed. Run:  winget install OpenJS.NodeJS.LTS   then run this script again.'
  }
  if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
    Push-Location $RepoRoot
    try {
      & npm install --no-audit --no-fund --loglevel=error | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
    } finally { Pop-Location }
    Write-Ok 'installed dockeriser''s Node packages'
  }
  Write-Host ''
  # Fresh permission grants take a minute or two to spread through Google, so the first check can
  # fail with "Google did not accept the credentials". Retry for up to ~3 minutes before giving up.
  $cli = Join-Path $RepoRoot 'bin\dockeriser.js'
  $attempts = 13
  for ($i = 1; $i -le $attempts; $i++) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $loginOut = & node $cli login 2>&1; $loginCode = $LASTEXITCODE } finally { $ErrorActionPreference = $previous }
    if ($loginCode -eq 0 -or $i -eq $attempts) { break }
    Write-Host "  waiting for Google to apply the new permissions$([char]0x2026)" -ForegroundColor DarkGray
    Start-Sleep -Seconds 15
  }
  $loginOut | ForEach-Object { Write-Host "$_" }
  if ($loginCode -ne 0) { exit $loginCode }
  Write-Host ''
  Write-Host 'Try a build:'
  Write-Host "  node `"$(Join-Path $RepoRoot 'bin\dockeriser.js')`" build `"$(Join-Path $RepoRoot 'examples\hello')`" --image hello"
} catch {
  Stop-Setup "$($_.Exception.Message)"
}
