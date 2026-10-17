#!/usr/bin/env bash
# One-command Google Cloud setup for dockeriser (bash version of setup.ps1). Safe to re-run.
#
# Usage: setup/setup.sh [-Project <id>] [-Region <r>] [-Repo <name>] [-BillingAccount <id>]
#                       [-Budget <dollars>] [-CreateKey]      (--project style flags also work)
# Without -Project it asks which project to use. With -Project it never asks.
set -euo pipefail

PROJECT=""
REGION="northamerica-northeast2"
REPO="docker-images"
BILLING_ACCOUNT=""
BUDGET=5
CREATE_KEY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -Project|--project) PROJECT="$2"; shift 2 ;;
    -Region|--region) REGION="$2"; shift 2 ;;
    -Repo|--repo) REPO="$2"; shift 2 ;;
    -BillingAccount|--billing-account) BILLING_ACCOUNT="$2"; shift 2 ;;
    -Budget|--budget) BUDGET="$2"; shift 2 ;;
    -CreateKey|--create-key) CREATE_KEY=1; shift ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The OS account's real profile, not $HOME/$USERPROFILE (Claude Code accounts point those at an
# account folder); the CLI looks there too. DOCKERISER_CONFIG_DIR overrides the whole folder.
REAL_HOME="$(node -p "require('os').userInfo().homedir" 2>/dev/null || true)"
CONFIG_DIR="${DOCKERISER_CONFIG_DIR:-${REAL_HOME:-${USERPROFILE:-$HOME}}/.dockeriser}"
CONFIG_FILE="$CONFIG_DIR/config.json"
KEY_PATH="$CONFIG_DIR/key.json"
ID_PATTERN='^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ok() { printf '\033[32m\xe2\x9c\x94 %s\033[0m\n' "$1"; }
skip() { printf '\033[90m  skipped: %s (already done)\033[0m\n' "$1"; }
fail() { printf '\033[31m\xe2\x9c\x96 %s\033[0m\n' "$1" >&2; }
die() { fail "$1"; exit 1; }
probe() { "$@" 2>/dev/null | tr -d '\r'; }                 # quiet, never fails the script
run() {                                                    # quiet, stops the script on failure
  local out
  if ! out="$("$@" 2>&1)"; then die "gcloud $2 $3 failed: $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"; fi
}
retry() {
  local i
  for i in 1 2 3 4 5 6; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    [[ $i -eq 6 ]] && die "gcloud $2 $3 failed after retries"
    sleep $((5 * i))
  done
}
# has_binding <get-iam-policy command...> -- <role> <member>
has_binding() {
  local args=() role member
  while [[ "$1" != "--" ]]; do args+=("$1"); shift; done
  shift; role="$1"; member="$2"
  "${args[@]}" --flatten="bindings[].members" --format="value(bindings.role,bindings.members)" 2>/dev/null \
    | tr -d '\r' | grep -qxF "$(printf '%s\t%s' "$role" "$member")"
}
json_field() { node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").replace(/^﻿/,""));process.stdout.write(String(j[process.argv[2]]??""))}catch{}' "$1" "$2"; }
save_config() {
  mkdir -p "$CONFIG_DIR"
  printf '{\n  "project": "%s",\n  "region": "%s",\n  "repo": "%s",\n  "serviceAccount": "dockeriser@%s.iam.gserviceaccount.com"\n}\n' \
    "$PROJECT" "$REGION" "$REPO" "$PROJECT" > "$CONFIG_FILE"
}
read_project_id() {
  local id
  while true; do
    read -r -p "Project ID: " id
    id="$(printf '%s' "$id" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    [[ "$id" =~ $ID_PATTERN ]] && { PROJECT="$id"; return; }
    echo "  A project ID is 6-30 characters: lowercase letters, digits and hyphens, starting with a letter."
  done
}
open_url() { (command -v cmd.exe >/dev/null && cmd.exe /c start "" "$1") || (command -v xdg-open >/dev/null && xdg-open "$1") || (command -v open >/dev/null && open "$1") || true; } >/dev/null 2>&1
select_project() {
  local saved answer pick i
  saved="$( [[ -f "$CONFIG_FILE" ]] && json_field "$CONFIG_FILE" project || true)"
  if [[ -n "$saved" ]]; then
    read -r -p "Use project $saved? [Y/n] " answer
    if [[ -z "$answer" || "$answer" =~ ^[Yy] ]]; then PROJECT="$saved"; return; fi
  fi
  mapfile -t LINES < <(probe gcloud projects list --format='value(projectId,name)' --sort-by=projectId | sed '/^$/d')
  if [[ ${#LINES[@]} -gt 0 ]]; then
    echo "Which Google Cloud project should dockeriser use?"
    for i in "${!LINES[@]}"; do printf '  %d) %s\n' $((i + 1)) "${LINES[$i]//$'\t'/  }"; done
    echo "  N) Create a new project"
    while true; do
      read -r -p "Choose a number or N: " pick
      [[ "$pick" =~ ^[Nn]$ ]] && break
      if [[ "$pick" =~ ^[0-9]+$ ]] && (( pick >= 1 && pick <= ${#LINES[@]} )); then PROJECT="${LINES[$((pick - 1))]%%$'\t'*}"; return; fi
    done
  else
    echo "You have no Google Cloud projects yet, so let's make one."
  fi
  echo "Opening the \"create project\" page in your browser. Either create it there and type its ID here,"
  echo "or just type a new ID (e.g. my-builds-123) and this script will create it for you."
  open_url "https://console.cloud.google.com/projectcreate"
  read_project_id
}

# ------------------------------------------------------------------------ 1. gcloud + sign-in
command -v gcloud >/dev/null || die "The Google Cloud tool (gcloud) is not installed. Windows: winget install Google.CloudSDK (then a new terminal). Others: https://cloud.google.com/sdk/docs/install"
ACCOUNT="$(probe gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)"
if [[ -n "$ACCOUNT" ]]; then
  skip "signed in to Google as $ACCOUNT"
else
  echo "Signing in to Google: a browser window opens. Pick your account, then come back here."
  gcloud auth login || die "Google sign-in did not finish. Run this script again."
  ACCOUNT="$(probe gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)"
  [[ -n "$ACCOUNT" ]] || die "Google sign-in did not finish. Run this script again."
  ok "signed in to Google as $ACCOUNT"
fi

# ------------------------------------------------------------------------ 2. project
[[ -n "$PROJECT" ]] || select_project
PROJECT="$(printf '%s' "$PROJECT" | tr '[:upper:]' '[:lower:]')"
[[ "$PROJECT" =~ $ID_PATTERN ]] || die "\"$PROJECT\" is not a valid project ID (6-30 characters: lowercase letters, digits, hyphens; starts with a letter)."
SA_EMAIL="dockeriser@$PROJECT.iam.gserviceaccount.com"
SRC_BUCKET="gs://$PROJECT-dockeriser-src"
LOGS_BUCKET="gs://$PROJECT-dockeriser-logs"
if gcloud projects describe "$PROJECT" >/dev/null 2>&1; then
  skip "project $PROJECT exists"
else
  run gcloud projects create "$PROJECT" --name "$PROJECT"
  ok "created project $PROJECT"
fi
save_config

# ------------------------------------------------------------------------ 3. billing
if [[ "$(probe gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)')" == "True" ]]; then
  skip "billing is linked"
else
  if [[ -z "$BILLING_ACCOUNT" ]]; then
    mapfile -t ACCOUNTS < <(probe gcloud billing accounts list --filter=open=true --format='value(name,displayName)' | sed '/^$/d')
    [[ ${#ACCOUNTS[@]} -gt 0 ]] || die "You have no billing account yet. Create one (pay-as-you-go; the free tier still applies) at https://console.cloud.google.com/billing/create then run this script again."
    if [[ ${#ACCOUNTS[@]} -gt 1 ]]; then
      fail "You have more than one billing account. Pick one and run again with -BillingAccount:"
      printf '    %s\n' "${ACCOUNTS[@]//$'\t'/   }"
      first="${ACCOUNTS[0]%%$'\t'*}"
      echo
      echo "  $0 -Project $PROJECT -BillingAccount ${first#billingAccounts/}"
      exit 1
    fi
    BILLING_ACCOUNT="${ACCOUNTS[0]%%$'\t'*}"
  fi
  BILLING_ACCOUNT="${BILLING_ACCOUNT#billingAccounts/}"
  run gcloud billing projects link "$PROJECT" --billing-account "$BILLING_ACCOUNT"
  ok "linked billing account $BILLING_ACCOUNT"
fi

# ------------------------------------------------------------------------ 4. APIs
APIS=(cloudbuild.googleapis.com artifactregistry.googleapis.com storage.googleapis.com iam.googleapis.com
      iamcredentials.googleapis.com logging.googleapis.com serviceusage.googleapis.com billingbudgets.googleapis.com)
ENABLED="$(probe gcloud services list --enabled --project "$PROJECT" --format='value(config.name)')"
MISSING=()
for api in "${APIS[@]}"; do grep -qxF "$api" <<<"$ENABLED" || MISSING+=("$api"); done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  run gcloud services enable "${MISSING[@]}" --project "$PROJECT"
  ok "turned on ${#MISSING[@]} Google APIs"
else
  skip "Google APIs are on"
fi

# ------------------------------------------------------------------------ 5. service account
if gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT" >/dev/null 2>&1; then
  skip "service account $SA_EMAIL exists"
else
  run gcloud iam service-accounts create dockeriser --project "$PROJECT" --display-name "dockeriser (Cloud Build submitter and runner)"
  ok "created service account $SA_EMAIL"
fi

# ------------------------------------------------------------------------ 6. image repo
if gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  skip "image repo $REPO exists"
else
  run gcloud artifacts repositories create "$REPO" --repository-format=docker --location "$REGION" --project "$PROJECT" --description "Images built by dockeriser"
  ok "created image repo $REGION-docker.pkg.dev/$PROJECT/$REPO"
fi
# A Keep rule alone deletes nothing, so pair it with a Delete rule: anything older than a day
# goes, except the 20 newest versions of each image.
cat > "$TMP_DIR/cleanup.json" <<'JSON'
[
  { "name": "keep-20-most-recent", "action": { "type": "Keep" }, "mostRecentVersions": { "keepCount": 20 } },
  { "name": "delete-older-than-1d", "action": { "type": "Delete" }, "condition": { "tagState": "any", "olderThan": "1d" } }
]
JSON
run gcloud artifacts repositories set-cleanup-policies "$REPO" --location "$REGION" --project "$PROJECT" --policy "$TMP_DIR/cleanup.json" --no-dry-run --quiet
ok "image cleanup set (keeps the 20 newest versions of each image)"

# ------------------------------------------------------------------------ 7. buckets
for pair in "$SRC_BUCKET:1" "$LOGS_BUCKET:30"; do
  bucket="${pair%:*}"; days="${pair##*:}"
  if gcloud storage buckets describe "$bucket" --project "$PROJECT" >/dev/null 2>&1; then
    run gcloud storage buckets update "$bucket" --uniform-bucket-level-access --public-access-prevention --quiet
    skip "bucket $bucket exists"
  else
    run gcloud storage buckets create "$bucket" --project "$PROJECT" --location "$REGION" --uniform-bucket-level-access --public-access-prevention --quiet
    ok "created private bucket $bucket"
  fi
  printf '{ "rule": [ { "action": { "type": "Delete" }, "condition": { "age": %s } } ] }\n' "$days" > "$TMP_DIR/lifecycle.json"
  run gcloud storage buckets update "$bucket" --lifecycle-file="$TMP_DIR/lifecycle.json" --quiet
done
ok "buckets auto-delete old files (uploads after 1 day, logs after 30)"

# ------------------------------------------------------------------------ 8. permissions
MEMBER="serviceAccount:$SA_EMAIL"
GRANTED=0
for role in roles/cloudbuild.builds.editor roles/logging.logWriter roles/serviceusage.serviceUsageConsumer; do
  if ! has_binding gcloud projects get-iam-policy "$PROJECT" -- "$role" "$MEMBER"; then
    retry gcloud projects add-iam-policy-binding "$PROJECT" --member "$MEMBER" --role "$role" --condition=None --quiet
    GRANTED=$((GRANTED + 1))
  fi
done
if ! has_binding gcloud artifacts repositories get-iam-policy "$REPO" --location "$REGION" --project "$PROJECT" -- roles/artifactregistry.writer "$MEMBER"; then
  retry gcloud artifacts repositories add-iam-policy-binding "$REPO" --location "$REGION" --project "$PROJECT" --member "$MEMBER" --role roles/artifactregistry.writer --quiet
  GRANTED=$((GRANTED + 1))
fi
for pair in "$SRC_BUCKET roles/storage.objectAdmin" "$LOGS_BUCKET roles/storage.admin"; do
  bucket="${pair% *}"; role="${pair#* }"
  if ! has_binding gcloud storage buckets get-iam-policy "$bucket" -- "$role" "$MEMBER"; then
    retry gcloud storage buckets add-iam-policy-binding "$bucket" --member "$MEMBER" --role "$role" --quiet
    GRANTED=$((GRANTED + 1))
  fi
done
SA_GRANTS=("$MEMBER roles/iam.serviceAccountUser")
[[ "$ACCOUNT" == *.gserviceaccount.com ]] || SA_GRANTS+=("user:$ACCOUNT roles/iam.serviceAccountTokenCreator")
for pair in "${SA_GRANTS[@]}"; do
  who="${pair% *}"; role="${pair#* }"
  if ! has_binding gcloud iam service-accounts get-iam-policy "$SA_EMAIL" --project "$PROJECT" -- "$role" "$who"; then
    retry gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" --project "$PROJECT" --member "$who" --role "$role" --quiet
    GRANTED=$((GRANTED + 1))
  fi
done
if [[ $GRANTED -gt 0 ]]; then ok "granted $GRANTED permission(s) to the dockeriser account"; else skip "permissions are in place"; fi

# ------------------------------------------------------------------------ 9. budget alert
if [[ "$BUDGET" -gt 0 ]]; then
  BILLING_NAME="$(probe gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)')"
  BILLING_NAME="${BILLING_NAME#billingAccounts/}"
  if probe gcloud billing budgets list --billing-account="$BILLING_NAME" --billing-project "$PROJECT" --format='value(displayName)' | grep -qxF dockeriser; then
    skip 'budget alert "dockeriser" exists'
  elif gcloud billing budgets create --billing-account="$BILLING_NAME" --billing-project "$PROJECT" --display-name=dockeriser \
      --budget-amount="$BUDGET" --filter-projects="projects/$PROJECT" \
      --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 >/dev/null 2>&1; then
    ok "budget alert set: emails at 50%, 90% and 100% of $BUDGET a month"
  else
    fail "could not create the budget alert (you may need Billing Account Administrator). Set one by hand: https://console.cloud.google.com/billing/budgets"
  fi
fi

# ------------------------------------------------------------------------ 10. sign-in for dockeriser
if [[ $CREATE_KEY -eq 1 ]]; then
  if [[ -f "$KEY_PATH" ]]; then skip "key file $KEY_PATH exists"
  else
    mkdir -p "$CONFIG_DIR"
    run gcloud iam service-accounts keys create "$KEY_PATH" --iam-account "$SA_EMAIL" --project "$PROJECT"
    chmod 600 "$KEY_PATH" 2>/dev/null || true
    ok "saved a key file at $KEY_PATH (keep it private)"
  fi
else
  if [[ -n "${CLOUDSDK_CONFIG:-}" ]]; then ADC="$CLOUDSDK_CONFIG/application_default_credentials.json"
  elif [[ -n "${APPDATA:-}" ]]; then ADC="$APPDATA/gcloud/application_default_credentials.json"
  else ADC="$HOME/.config/gcloud/application_default_credentials.json"; fi
  if [[ -f "$ADC" && "$(json_field "$ADC" type)" == "impersonated_service_account" && "$(json_field "$ADC" service_account_impersonation_url)" == *"$SA_EMAIL"* ]]; then
    skip "dockeriser signs in as $SA_EMAIL"
  else
    echo "One more browser sign-in: this lets dockeriser act as its build account."
    gcloud auth application-default login --impersonate-service-account="$SA_EMAIL" || die "That sign-in did not finish. Run this script again."
    ok "dockeriser signs in as $SA_EMAIL"
  fi
fi
save_config
ok "saved settings to $CONFIG_FILE"

# ------------------------------------------------------------------------ 11. check
command -v node >/dev/null || die "Node.js is not installed (Windows: winget install OpenJS.NodeJS.LTS). Then run this script again."
if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
  (cd "$REPO_ROOT" && npm install --no-audit --no-fund --loglevel=error >/dev/null) || die "npm install failed"
  ok "installed dockeriser's Node packages"
fi
echo
# Fresh permission grants take a minute or two to spread through Google, so the first check can
# fail with "Google did not accept the credentials". Retry for up to ~3 minutes before giving up.
for attempt in $(seq 1 13); do
  if LOGIN_OUT="$(node "$REPO_ROOT/bin/dockeriser.js" login 2>&1)"; then LOGIN_CODE=0; else LOGIN_CODE=$?; fi
  [[ $LOGIN_CODE -eq 0 || $attempt -eq 13 ]] && break
  printf '\033[90m  waiting for Google to apply the new permissions\xe2\x80\xa6\033[0m\n'
  sleep 15
done
printf '%s\n' "$LOGIN_OUT"
[[ $LOGIN_CODE -eq 0 ]] || exit "$LOGIN_CODE"
echo
echo "Try a build:"
echo "  node \"$REPO_ROOT/bin/dockeriser.js\" build \"$REPO_ROOT/examples/hello\" --image hello"
