<#
.SYNOPSIS
  One-time Google Cloud setup for dockeriser. Safe to re-run: every step checks before it creates.

.DESCRIPTION
  Enables the needed APIs, creates the Artifact Registry repo (with a cleanup policy), the source
  and logs buckets (with auto-delete rules), the "dockeriser" service account and its permissions,
  then writes %USERPROFILE%\.dockeriser\config.json. Optionally saves a key file (-CreateKey).

  Needs: gcloud installed and signed in (gcloud auth login) as an owner of the project, and
  billing linked to the project.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup\setup.ps1 -Project my-project-123

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup\setup.ps1 -Project my-project-123 -Region us-central1 -CreateKey
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Project,
  [string]$Region = 'northamerica-northeast2',
  [string]$Repo = 'docker-images',
  [switch]$CreateKey
)

$ErrorActionPreference = 'Stop'
$SaName = 'dockeriser'
$SaEmail = "$SaName@$Project.iam.gserviceaccount.com"
$SrcBucket = "gs://$Project-dockeriser-src"
$LogsBucket = "gs://$Project-dockeriser-logs"
$ConfigDir = Join-Path $env:USERPROFILE '.dockeriser'
$KeyPath = Join-Path $ConfigDir 'key.json'
$Apis = @(
  'cloudbuild.googleapis.com',
  'artifactregistry.googleapis.com',
  'storage.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'logging.googleapis.com',
  'serviceusage.googleapis.com'
)
$Summary = New-Object System.Collections.Generic.List[string]

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Done([string]$Text) { Write-Host "    $Text"; $Summary.Add($Text) }

# Run gcloud and stop the script if it fails.
# (Plain functions with $args, so gcloud flags like --project pass straight through.)
function Invoke-Gcloud {
  & gcloud @args
  if ($LASTEXITCODE -ne 0) { throw "gcloud $($args -join ' ') failed (exit $LASTEXITCODE)" }
}

# Run gcloud as a yes/no probe: returns @{ Ok; Out } and never throws (stderr hidden).
function Test-Gcloud {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & gcloud @args 2>$null
    return @{ Ok = ($LASTEXITCODE -eq 0); Out = ($out -join "`n") }
  } finally {
    $ErrorActionPreference = $previous
  }
}

# Retry a block a few times (new service accounts take a few seconds to be visible to IAM).
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

# ---------------------------------------------------------------------------
Write-Step 'Checking gcloud'
if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  throw 'gcloud is not installed. Run: winget install Google.CloudSDK   then open a new terminal and run: gcloud auth login'
}
$account = (Test-Gcloud config get-value account).Out.Trim()
if (-not $account) { throw 'gcloud is not signed in. Run: gcloud auth login' }
Write-Host "    signed in as $account"
if (-not (Test-Gcloud projects describe $Project '--format=value(projectId)').Ok) {
  throw "Project $Project was not found, or $account cannot see it. Check the project ID at https://console.cloud.google.com/projectselector2/home/dashboard"
}

$billing = Test-Gcloud billing projects describe $Project '--format=value(billingEnabled)'
if ($billing.Ok -and $billing.Out.Trim() -ne 'True') {
  Write-Warning "Billing is not linked to $Project. Cloud Build needs it even inside the free tier: https://console.cloud.google.com/billing/linkedaccount?project=$Project"
}

# ---------------------------------------------------------------------------
Write-Step 'Turning on the APIs'
$enabled = (Test-Gcloud services list --enabled --project $Project '--format=value(config.name)').Out -split "`n"
$missing = @($Apis | Where-Object { $enabled -notcontains $_ })
if ($missing.Count -gt 0) {
  Invoke-Gcloud services enable @missing --project $Project
  Write-Done "enabled APIs: $($missing -join ', ')"
} else {
  Write-Host '    all APIs already on'
}

# ---------------------------------------------------------------------------
Write-Step "Service account $SaEmail"
if ((Test-Gcloud iam service-accounts describe $SaEmail --project $Project).Ok) {
  Write-Host '    already exists'
} else {
  Invoke-Gcloud iam service-accounts create $SaName --project $Project --display-name 'dockeriser (Cloud Build submitter and runner)'
  Write-Done "created service account $SaEmail"
}

# ---------------------------------------------------------------------------
Write-Step "Artifact Registry repo $Repo in $Region"
if ((Test-Gcloud artifacts repositories describe $Repo --location $Region --project $Project).Ok) {
  Write-Host '    already exists'
} else {
  Invoke-Gcloud artifacts repositories create $Repo --repository-format=docker --location $Region --project $Project --description 'Images built by dockeriser'
  Write-Done "created Docker repo $Region-docker.pkg.dev/$Project/$Repo"
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
Invoke-Gcloud artifacts repositories set-cleanup-policies $Repo --location $Region --project $Project --policy $policyFile --no-dry-run --quiet | Out-Null
Remove-Item $policyFile -Force
Write-Host '    cleanup policy set (keep the 10 newest versions per image)'

# ---------------------------------------------------------------------------
foreach ($pair in @(@($SrcBucket, 1), @($LogsBucket, 30))) {
  $bucket = $pair[0]; $days = $pair[1]
  Write-Step "Bucket $bucket"
  if ((Test-Gcloud storage buckets describe $bucket --project $Project).Ok) {
    Write-Host '    already exists'
    Invoke-Gcloud storage buckets update $bucket --uniform-bucket-level-access --public-access-prevention --quiet | Out-Null
  } else {
    Invoke-Gcloud storage buckets create $bucket --project $Project --location $Region --uniform-bucket-level-access --public-access-prevention --quiet
    Write-Done "created bucket $bucket ($Region, private)"
  }
  $lifecycleFile = Join-Path $env:TEMP 'dockeriser-lifecycle.json'
  Write-Utf8File $lifecycleFile "{ `"rule`": [ { `"action`": { `"type`": `"Delete`" }, `"condition`": { `"age`": $days } } ] }"
  Invoke-Gcloud storage buckets update $bucket --lifecycle-file=$lifecycleFile --quiet | Out-Null
  Remove-Item $lifecycleFile -Force
  Write-Host "    files auto-delete after $days day(s)"
}

# ---------------------------------------------------------------------------
Write-Step 'Permissions'
$member = "serviceAccount:$SaEmail"

$projectPolicy = (Test-Gcloud projects get-iam-policy $Project --format=json).Out
foreach ($role in @('roles/cloudbuild.builds.editor', 'roles/logging.logWriter', 'roles/serviceusage.serviceUsageConsumer')) {
  if (Test-Binding $projectPolicy $role $member) { Write-Host "    $role (project): already granted" }
  else {
    Invoke-WithRetry { Invoke-Gcloud projects add-iam-policy-binding $Project --member $member --role $role --condition=None --quiet | Out-Null }
    Write-Done "granted $role on the project"
  }
}

$repoPolicy = (Test-Gcloud artifacts repositories get-iam-policy $Repo --location $Region --project $Project --format=json).Out
if (Test-Binding $repoPolicy 'roles/artifactregistry.writer' $member) { Write-Host '    roles/artifactregistry.writer (repo): already granted' }
else {
  Invoke-WithRetry { Invoke-Gcloud artifacts repositories add-iam-policy-binding $Repo --location $Region --project $Project --member $member --role roles/artifactregistry.writer --quiet | Out-Null }
  Write-Done "granted roles/artifactregistry.writer on $Repo"
}

foreach ($pair in @(@($SrcBucket, 'roles/storage.objectAdmin'), @($LogsBucket, 'roles/storage.admin'))) {
  $bucket = $pair[0]; $role = $pair[1]
  $bucketPolicy = (Test-Gcloud storage buckets get-iam-policy $bucket --format=json).Out
  if (Test-Binding $bucketPolicy $role $member) { Write-Host "    $role ($bucket): already granted" }
  else {
    Invoke-WithRetry { Invoke-Gcloud storage buckets add-iam-policy-binding $bucket --member $member --role $role --quiet | Out-Null }
    Write-Done "granted $role on $bucket"
  }
}

$saPolicy = (Test-Gcloud iam service-accounts get-iam-policy $SaEmail --project $Project --format=json).Out
if (Test-Binding $saPolicy 'roles/iam.serviceAccountUser' $member) { Write-Host '    roles/iam.serviceAccountUser (on itself): already granted' }
else {
  Invoke-WithRetry { Invoke-Gcloud iam service-accounts add-iam-policy-binding $SaEmail --project $Project --member $member --role roles/iam.serviceAccountUser --quiet | Out-Null }
  Write-Done 'granted roles/iam.serviceAccountUser to the service account on itself'
}
if ($account -notlike '*.gserviceaccount.com') {
  $userMember = "user:$account"
  if (Test-Binding $saPolicy 'roles/iam.serviceAccountTokenCreator' $userMember) { Write-Host "    roles/iam.serviceAccountTokenCreator ($account): already granted" }
  else {
    Invoke-WithRetry { Invoke-Gcloud iam service-accounts add-iam-policy-binding $SaEmail --project $Project --member $userMember --role roles/iam.serviceAccountTokenCreator --quiet | Out-Null }
    Write-Done "granted roles/iam.serviceAccountTokenCreator to $account (lets you sign in as the service account)"
  }
}

# ---------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
if ($CreateKey) {
  Write-Step "Key file $KeyPath"
  if (Test-Path $KeyPath) {
    Write-Host '    already exists (delete it first to make a new one)'
  } else {
    Invoke-Gcloud iam service-accounts keys create $KeyPath --iam-account $SaEmail --project $Project
    Write-Done "saved a key file at $KeyPath (keep it private; never commit it)"
  }
}

Write-Step "Config $ConfigDir\config.json"
$config = [ordered]@{ project = $Project; region = $Region; repo = $Repo; serviceAccount = $SaEmail } | ConvertTo-Json
Write-Utf8File (Join-Path $ConfigDir 'config.json') ($config + "`n")
Write-Done "wrote $ConfigDir\config.json"

# ---------------------------------------------------------------------------
$cli = Join-Path (Split-Path -Parent $PSScriptRoot) 'bin\dockeriser.js'
Write-Host ''
Write-Host 'Setup finished.' -ForegroundColor Green
if ($Summary.Count -gt 0) { $Summary | ForEach-Object { Write-Host "  - $_" } } else { Write-Host '  - nothing to change; everything was already in place' }
Write-Host ''
if (-not $CreateKey -and -not (Test-Path $KeyPath)) {
  Write-Host 'Next, let dockeriser act as the service account (opens a browser once):'
  Write-Host "  gcloud auth application-default login --impersonate-service-account=$SaEmail"
  Write-Host ''
}
Write-Host 'Then check everything:'
Write-Host "  node `"$cli`" doctor"
