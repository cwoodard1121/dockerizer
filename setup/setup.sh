#!/usr/bin/env bash
# One-time Google Cloud setup for dockeriser (bash version of setup.ps1). Safe to re-run:
# every step checks before it creates.
#
# Usage: setup/setup.sh -Project <id> [-Region <region>] [-Repo <name>] [-CreateKey]
#        (--project/--region/--repo/--create-key also work)
# Needs: gcloud installed and signed in (gcloud auth login) as a project owner; billing linked.
set -euo pipefail

PROJECT=""
REGION="northamerica-northeast2"
REPO="docker-images"
CREATE_KEY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -Project|--project) PROJECT="$2"; shift 2 ;;
    -Region|--region) REGION="$2"; shift 2 ;;
    -Repo|--repo) REPO="$2"; shift 2 ;;
    -CreateKey|--create-key) CREATE_KEY=1; shift ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$PROJECT" ]] || { echo "Missing -Project <id>" >&2; exit 2; }

SA_NAME="dockeriser"
SA_EMAIL="$SA_NAME@$PROJECT.iam.gserviceaccount.com"
SRC_BUCKET="gs://$PROJECT-dockeriser-src"
LOGS_BUCKET="gs://$PROJECT-dockeriser-logs"
CONFIG_DIR="${USERPROFILE:-$HOME}/.dockeriser"
KEY_PATH="$CONFIG_DIR/key.json"
APIS=(cloudbuild.googleapis.com artifactregistry.googleapis.com storage.googleapis.com iam.googleapis.com
      iamcredentials.googleapis.com logging.googleapis.com serviceusage.googleapis.com)
SUMMARY=()
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

step() { printf '==> %s\n' "$1"; }
done_() { printf '    %s\n' "$1"; SUMMARY+=("$1"); }
quiet() { "$@" >/dev/null 2>&1; }

# retry <cmd...>: new service accounts take a few seconds to be visible to IAM.
retry() {
  local i
  for i in 1 2 3 4 5 6; do
    if "$@" >/dev/null; then return 0; fi
    [[ $i -eq 6 ]] && return 1
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

# ---------------------------------------------------------------------------
step "Checking gcloud"
command -v gcloud >/dev/null || { echo "gcloud is not installed (Windows: winget install Google.CloudSDK). Then run: gcloud auth login" >&2; exit 1; }
ACCOUNT="$(gcloud config get-value account 2>/dev/null | tr -d '\r')"
[[ -n "$ACCOUNT" ]] || { echo "gcloud is not signed in. Run: gcloud auth login" >&2; exit 1; }
echo "    signed in as $ACCOUNT"
quiet gcloud projects describe "$PROJECT" || { echo "Project $PROJECT not found, or $ACCOUNT cannot see it." >&2; exit 1; }
BILLING="$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null | tr -d '\r' || true)"
if [[ -n "$BILLING" && "$BILLING" != "True" ]]; then
  echo "WARNING: billing is not linked to $PROJECT. Cloud Build needs it even inside the free tier:" >&2
  echo "         https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT" >&2
fi

# ---------------------------------------------------------------------------
step "Turning on the APIs"
ENABLED="$(gcloud services list --enabled --project "$PROJECT" --format='value(config.name)' 2>/dev/null | tr -d '\r')"
MISSING=()
for api in "${APIS[@]}"; do grep -qxF "$api" <<<"$ENABLED" || MISSING+=("$api"); done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  gcloud services enable "${MISSING[@]}" --project "$PROJECT"
  done_ "enabled APIs: ${MISSING[*]}"
else
  echo "    all APIs already on"
fi

# ---------------------------------------------------------------------------
step "Service account $SA_EMAIL"
if quiet gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT"; then
  echo "    already exists"
else
  gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT" --display-name "dockeriser (Cloud Build submitter and runner)"
  done_ "created service account $SA_EMAIL"
fi

# ---------------------------------------------------------------------------
step "Artifact Registry repo $REPO in $REGION"
if quiet gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$PROJECT"; then
  echo "    already exists"
else
  gcloud artifacts repositories create "$REPO" --repository-format=docker --location "$REGION" --project "$PROJECT" --description "Images built by dockeriser"
  done_ "created Docker repo $REGION-docker.pkg.dev/$PROJECT/$REPO"
fi
# A Keep rule alone deletes nothing, so pair it with a Delete rule: anything older than a day
# goes, except the 10 newest versions of each image.
cat > "$TMP_DIR/cleanup.json" <<'JSON'
[
  { "name": "keep-10-most-recent", "action": { "type": "Keep" }, "mostRecentVersions": { "keepCount": 10 } },
  { "name": "delete-older-than-1d", "action": { "type": "Delete" }, "condition": { "tagState": "any", "olderThan": "1d" } }
]
JSON
gcloud artifacts repositories set-cleanup-policies "$REPO" --location "$REGION" --project "$PROJECT" --policy "$TMP_DIR/cleanup.json" --no-dry-run --quiet >/dev/null
echo "    cleanup policy set (keep the 10 newest versions per image)"

# ---------------------------------------------------------------------------
for pair in "$SRC_BUCKET:1" "$LOGS_BUCKET:30"; do
  bucket="${pair%:*}"; days="${pair##*:}"
  step "Bucket $bucket"
  if quiet gcloud storage buckets describe "$bucket" --project "$PROJECT"; then
    echo "    already exists"
    gcloud storage buckets update "$bucket" --uniform-bucket-level-access --public-access-prevention --quiet >/dev/null
  else
    gcloud storage buckets create "$bucket" --project "$PROJECT" --location "$REGION" --uniform-bucket-level-access --public-access-prevention --quiet
    done_ "created bucket $bucket ($REGION, private)"
  fi
  printf '{ "rule": [ { "action": { "type": "Delete" }, "condition": { "age": %s } } ] }\n' "$days" > "$TMP_DIR/lifecycle.json"
  gcloud storage buckets update "$bucket" --lifecycle-file="$TMP_DIR/lifecycle.json" --quiet >/dev/null
  echo "    files auto-delete after $days day(s)"
done

# ---------------------------------------------------------------------------
step "Permissions"
MEMBER="serviceAccount:$SA_EMAIL"
for role in roles/cloudbuild.builds.editor roles/logging.logWriter roles/serviceusage.serviceUsageConsumer; do
  if has_binding gcloud projects get-iam-policy "$PROJECT" -- "$role" "$MEMBER"; then
    echo "    $role (project): already granted"
  else
    retry gcloud projects add-iam-policy-binding "$PROJECT" --member "$MEMBER" --role "$role" --condition=None --quiet
    done_ "granted $role on the project"
  fi
done

if has_binding gcloud artifacts repositories get-iam-policy "$REPO" --location "$REGION" --project "$PROJECT" -- roles/artifactregistry.writer "$MEMBER"; then
  echo "    roles/artifactregistry.writer (repo): already granted"
else
  retry gcloud artifacts repositories add-iam-policy-binding "$REPO" --location "$REGION" --project "$PROJECT" --member "$MEMBER" --role roles/artifactregistry.writer --quiet
  done_ "granted roles/artifactregistry.writer on $REPO"
fi

for pair in "$SRC_BUCKET roles/storage.objectAdmin" "$LOGS_BUCKET roles/storage.admin"; do
  bucket="${pair% *}"; role="${pair#* }"
  if has_binding gcloud storage buckets get-iam-policy "$bucket" -- "$role" "$MEMBER"; then
    echo "    $role ($bucket): already granted"
  else
    retry gcloud storage buckets add-iam-policy-binding "$bucket" --member "$MEMBER" --role "$role" --quiet
    done_ "granted $role on $bucket"
  fi
done

if has_binding gcloud iam service-accounts get-iam-policy "$SA_EMAIL" --project "$PROJECT" -- roles/iam.serviceAccountUser "$MEMBER"; then
  echo "    roles/iam.serviceAccountUser (on itself): already granted"
else
  retry gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" --project "$PROJECT" --member "$MEMBER" --role roles/iam.serviceAccountUser --quiet
  done_ "granted roles/iam.serviceAccountUser to the service account on itself"
fi
if [[ "$ACCOUNT" != *.gserviceaccount.com ]]; then
  if has_binding gcloud iam service-accounts get-iam-policy "$SA_EMAIL" --project "$PROJECT" -- roles/iam.serviceAccountTokenCreator "user:$ACCOUNT"; then
    echo "    roles/iam.serviceAccountTokenCreator ($ACCOUNT): already granted"
  else
    retry gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" --project "$PROJECT" --member "user:$ACCOUNT" --role roles/iam.serviceAccountTokenCreator --quiet
    done_ "granted roles/iam.serviceAccountTokenCreator to $ACCOUNT (lets you sign in as the service account)"
  fi
fi

# ---------------------------------------------------------------------------
mkdir -p "$CONFIG_DIR"
if [[ $CREATE_KEY -eq 1 ]]; then
  step "Key file $KEY_PATH"
  if [[ -f "$KEY_PATH" ]]; then
    echo "    already exists (delete it first to make a new one)"
  else
    gcloud iam service-accounts keys create "$KEY_PATH" --iam-account "$SA_EMAIL" --project "$PROJECT"
    chmod 600 "$KEY_PATH" 2>/dev/null || true
    done_ "saved a key file at $KEY_PATH (keep it private; never commit it)"
  fi
fi

step "Config $CONFIG_DIR/config.json"
printf '{\n  "project": "%s",\n  "region": "%s",\n  "repo": "%s",\n  "serviceAccount": "%s"\n}\n' \
  "$PROJECT" "$REGION" "$REPO" "$SA_EMAIL" > "$CONFIG_DIR/config.json"
done_ "wrote $CONFIG_DIR/config.json"

# ---------------------------------------------------------------------------
CLI="$(cd "$(dirname "$0")/.." && pwd)/bin/dockeriser.js"
echo
echo "Setup finished."
if [[ ${#SUMMARY[@]} -gt 0 ]]; then printf '  - %s\n' "${SUMMARY[@]}"; else echo "  - nothing to change; everything was already in place"; fi
echo
if [[ $CREATE_KEY -eq 0 && ! -f "$KEY_PATH" ]]; then
  echo "Next, let dockeriser act as the service account (opens a browser once):"
  echo "  gcloud auth application-default login --impersonate-service-account=$SA_EMAIL"
  echo
fi
echo "Then check everything:"
echo "  node \"$CLI\" doctor"
