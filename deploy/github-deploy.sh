#!/usr/bin/env bash
set -Eeuo pipefail

readonly DEFAULT_REPOSITORY_URL="https://github.com/glennprays/9router.git"
readonly DEPLOY_ROOT="/opt/9router"
readonly DATA_ROOT="/var/lib/9router"
readonly ENV_PATH="/etc/9router/9router.env"
readonly SERVICE_NAME="9router.service"
readonly SERVICE_UNIT_PATH="/etc/systemd/system/9router.service"
readonly HEALTH_URL="http://127.0.0.1:20128/api/health"
readonly TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

readonly GIT_BIN="/usr/bin/git"
readonly NODE_BIN="/usr/bin/node"
readonly NPM_BIN="/usr/bin/npm"
readonly CURL_BIN="/usr/bin/curl"
readonly SYSTEMCTL_BIN="/usr/bin/systemctl"
readonly READLINK_BIN="/usr/bin/readlink"
readonly RUNUSER_BIN="/usr/sbin/runuser"
readonly ID_BIN="/usr/bin/id"
readonly USERADD_BIN="/usr/sbin/useradd"
readonly STAT_BIN="/usr/bin/stat"
readonly MKDIR_BIN="/usr/bin/mkdir"
readonly RM_BIN="/usr/bin/rm"
readonly DIRNAME_BIN="/usr/bin/dirname"
readonly MV_BIN="/usr/bin/mv"
readonly LN_BIN="/usr/bin/ln"
readonly CP_BIN="/usr/bin/cp"
readonly CHOWN_BIN="/usr/bin/chown"
readonly CHMOD_BIN="/usr/bin/chmod"
readonly INSTALL_BIN="/usr/bin/install"
readonly RMDIR_BIN="/usr/bin/rmdir"
readonly DATE_BIN="/usr/bin/date"
readonly SLEEP_BIN="/usr/bin/sleep"
readonly RELEASES_DIR="$DEPLOY_ROOT/releases"
readonly UPDATE_DIR="$DEPLOY_ROOT/update"
readonly STAGING_DIR="$DATA_ROOT/runtime/deploy-staging"
readonly LOCK_DIR="$UPDATE_DIR/deploy.lock"
readonly CURRENT_LINK="$DEPLOY_ROOT/current"
readonly CURRENT_NEW_LINK="$DEPLOY_ROOT/current.new"
readonly DATABASE_FILE="$DATA_ROOT/db/data.sqlite"
readonly BACKUP_DIR="$DATA_ROOT/backups"
operation=""
tag=""
repository_url="${NINEROUTER_REPOSITORY_URL:-$DEFAULT_REPOSITORY_URL}"
phase="arguments"
failure_code="deployment-failed"
status_record_written=0
deployment_started=0
lock_held=0
candidate_cleanup=0
transaction_active=0
rollback_attempted=0
backup_ready=0
release_dir=""
candidate_dir=""
current_tag=""
previous_tag=""
previous_target=""
backup_path=""
database_existed_before=0
started_at=""

usage() {
  cat <<'EOF'
Usage:
  sudo bash deploy/github-deploy.sh install --tag v0.5.70
  sudo bash deploy/github-deploy.sh update --tag v0.5.71
  sudo bash deploy/github-deploy.sh --help

Install or update 9Router from an exact tag in the configured GitHub repository.
EOF
}

fail() {
  failure_code="$1"
  printf 'github-deploy: %s\n' "$1" >&2
  exit 1
}

argument_error() {
  printf 'github-deploy: %s\n' "$1" >&2
  exit 2
}

if [[ "$#" -eq 1 && "$1" == "--help" ]]; then
  usage
  exit 0
fi
if [[ "${UPDATE_ROOT+x}" == x || "${DATA_DIR+x}" == x || "${ENV_FILE+x}" == x ]]; then
  argument_error "path overrides are not supported; use the checked-in deployment paths"
fi

if [[ "$#" -lt 1 ]]; then
  usage >&2
  exit 2
fi

operation="$1"
shift
if [[ "$operation" != "install" && "$operation" != "update" ]]; then
  argument_error "expected install or update"
fi

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --tag)
      [[ "$#" -ge 2 ]] || argument_error "--tag requires a value"
      [[ -z "$tag" ]] || argument_error "--tag may be specified only once"
      tag="$2"
      shift 2
      ;;
    --help)
      argument_error "--help must be used by itself"
      ;;
    *)
      argument_error "unknown argument"
      ;;
  esac
done

[[ -n "$tag" ]] || argument_error "--tag is required"
[[ "$tag" =~ $TAG_PATTERN ]] || argument_error "tag must be a release tag such as v0.5.70"
[[ "$repository_url" =~ ^https://github\.com/[^/]+/[^/]+\.git$ ]] || argument_error "repository URL must be an HTTPS GitHub .git URL"

[[ "$EUID" -eq 0 ]] || argument_error "install and update require root"

for prerequisite in \
  "$GIT_BIN" "$NODE_BIN" "$NPM_BIN" "$CURL_BIN" "$SYSTEMCTL_BIN" "$READLINK_BIN" \
  "$RUNUSER_BIN" "$ID_BIN" "$USERADD_BIN" "$STAT_BIN" "$MKDIR_BIN" "$RM_BIN" "$DIRNAME_BIN" "$MV_BIN" \
  "$LN_BIN" "$CP_BIN" "$CHOWN_BIN" "$CHMOD_BIN" "$INSTALL_BIN" "$RMDIR_BIN" "$DATE_BIN" "$SLEEP_BIN"; do
  [[ -x "$prerequisite" ]] || argument_error "missing prerequisite: $prerequisite"
done
started_at="$($DATE_BIN -u +%Y-%m-%dT%H:%M:%SZ)"

status_value() {
  if [[ -n "$1" ]]; then
    printf '"%s"' "$1"
  else
    printf 'null'
  fi
}

write_status() {
  local success="$1"
  local error="$2"
  local finished_at
  local status_tmp
  finished_at="$($DATE_BIN -u +%Y-%m-%dT%H:%M:%SZ)"
  status_tmp="$UPDATE_DIR/status.json.new.$$"
  "$MKDIR_BIN" -p "$UPDATE_DIR"
  if [[ -n "$error" ]]; then
    error="\"$error\""
  else
    error="null"
  fi
  printf '{"phase":"%s","tag":"%s","currentTag":%s,"previousTag":%s,"startedAt":"%s","finishedAt":"%s","success":%s,"error":%s}\n' \
    "$phase" "$tag" "$(status_value "$current_tag")" "$(status_value "$previous_tag")" \
    "$started_at" "$finished_at" "$success" "$error" > "$status_tmp"
  "$MV_BIN" -f -- "$status_tmp" "$UPDATE_DIR/status.json"
  status_record_written=1
}

write_failure_log() {
  local timestamp
  local log_file
  timestamp="$($DATE_BIN -u +%Y%m%dT%H%M%SZ)"
  log_file="$UPDATE_DIR/failure-${timestamp}-${tag}.log"
  printf 'phase=%s\ntag=%s\ncurrentTag=%s\npreviousTag=%s\nerror=%s\n' \
    "$phase" "$tag" "${current_tag:-unknown}" "${previous_tag:-unknown}" "$failure_code" > "$log_file"
  "$CHMOD_BIN" 0600 "$log_file" 2>/dev/null || true
}

release_lock() {
  if [[ "$lock_held" -eq 1 ]]; then
    "$RMDIR_BIN" "$LOCK_DIR" 2>/dev/null || true
    lock_held=0
  fi
}

rollback_update() {
  local rollback_failed=0
  phase="rollback"
  rollback_attempted=1
  "$SYSTEMCTL_BIN" stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  "$RM_BIN" -f -- "$CURRENT_NEW_LINK"
  if [[ -z "$previous_target" ]] || ! "$LN_BIN" -s -- "$previous_target" "$CURRENT_NEW_LINK" || ! "$MV_BIN" -Tf -- "$CURRENT_NEW_LINK" "$CURRENT_LINK"; then
    rollback_failed=1
  fi
  if [[ "$backup_ready" -eq 1 ]]; then
    if ! "$CP_BIN" -- "$backup_path" "$DATABASE_FILE"; then
      rollback_failed=1
    elif ! "$CHOWN_BIN" 9router:9router "$DATABASE_FILE" || ! "$CHMOD_BIN" 0600 "$DATABASE_FILE"; then
      rollback_failed=1
    fi
  elif [[ "$database_existed_before" -eq 0 ]]; then
    "$RM_BIN" -f -- "$DATABASE_FILE" || rollback_failed=1
  fi
  if ! "$SYSTEMCTL_BIN" start "$SERVICE_NAME" >/dev/null 2>&1; then
    rollback_failed=1
  fi
  transaction_active=0
  if [[ "$rollback_failed" -eq 1 ]]; then
    failure_code="rollback-failed"
  fi
  return "$rollback_failed"
}

on_exit() {
  local exit_code=$?
  local original_failure
  local rollback_result
  trap - EXIT
  if [[ "$exit_code" -ne 0 ]]; then
    if [[ "$transaction_active" -eq 1 && "$rollback_attempted" -eq 0 ]]; then
      original_failure="$failure_code"
      if rollback_update; then
        rollback_result=0
      else
        rollback_result=$?
      fi
      failure_code="$original_failure"
      [[ "$rollback_result" -eq 0 ]] || failure_code="rollback-failed"
    fi
    if [[ "$candidate_cleanup" -eq 1 && -n "$candidate_dir" && -d "$candidate_dir" ]]; then
      "$RM_BIN" -rf -- "$candidate_dir" 2>/dev/null || true
    fi
    if [[ "$deployment_started" -eq 1 && -d "$UPDATE_DIR" ]]; then
      write_failure_log 2>/dev/null || true
      if [[ "$status_record_written" -eq 0 ]]; then
        write_status false "$failure_code" 2>/dev/null || true
      fi
    fi
  fi
  release_lock
  exit "$exit_code"
}
trap on_exit EXIT

enforce_environment_assignment() {
  local file="$1"
  local line
  local key
  local value
  local seen_data=0
  local seen_port=0
  local seen_source=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ ! "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      failure_code="invalid-environment-file"
      return 1
    fi
    [[ -z "${BASH_REMATCH[1]}" ]] || { failure_code="invalid-environment-file"; return 1; }
    key="${BASH_REMATCH[2]}"
    value="${BASH_REMATCH[3]}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    case "$key" in
      DATA_DIR)
        [[ "$seen_data" -eq 0 ]] || { failure_code="environment-duplicate-data-dir"; return 1; }
        seen_data=1
        [[ "$value" == "/var/lib/9router" ]] || { failure_code="environment-data-dir-mismatch"; return 1; }
        ;;
      PORT)
        [[ "$seen_port" -eq 0 ]] || { failure_code="environment-duplicate-port"; return 1; }
        seen_port=1
        [[ "$value" == "20128" ]] || { failure_code="environment-port-mismatch"; return 1; }
        ;;
      UPDATE_SOURCE)
        [[ "$seen_source" -eq 0 ]] || { failure_code="environment-duplicate-update-source"; return 1; }
        seen_source=1
        [[ "$value" == "external" ]] || { failure_code="environment-update-source-mismatch"; return 1; }
        ;;
    esac
  done < "$file"
  [[ "$seen_data" -eq 1 ]] || { failure_code="environment-data-dir-missing"; return 1; }
  [[ "$seen_port" -eq 1 ]] || { failure_code="environment-port-missing"; return 1; }
  [[ "$seen_source" -eq 1 ]] || { failure_code="environment-update-source-missing"; return 1; }
}

ensure_account_and_directories() {
  phase="prepare"
  if ! "$ID_BIN" -u 9router >/dev/null 2>&1; then
    "$USERADD_BIN" --system --home-dir "$DATA_ROOT" --shell /usr/sbin/nologin 9router || fail "account-creation-failed"
  fi
  "$MKDIR_BIN" -p "$RELEASES_DIR" "$UPDATE_DIR" "$STAGING_DIR" "$DATA_ROOT/db" "$BACKUP_DIR" /etc/9router
  "$CHMOD_BIN" 0755 "$DEPLOY_ROOT" "$RELEASES_DIR" /etc/9router
  "$CHMOD_BIN" 0700 "$UPDATE_DIR" "$STAGING_DIR"
  "$CHMOD_BIN" 0750 "$DATA_ROOT" "$DATA_ROOT/db" "$BACKUP_DIR"
  "$CHOWN_BIN" root:root "$DEPLOY_ROOT" "$RELEASES_DIR" "$UPDATE_DIR" /etc/9router
  "$CHOWN_BIN" 9router:9router "$STAGING_DIR" "$DATA_ROOT" "$DATA_ROOT/db" "$BACKUP_DIR"
}

ensure_environment() {
  local owner
  local group
  local mode
  if [[ -L "$ENV_PATH" ]]; then
    failure_code="invalid-environment-file"
    exit 2
  fi
  if [[ ! -e "$ENV_PATH" ]]; then
    umask 077
    printf 'DATA_DIR=/var/lib/9router\nPORT=20128\nNODE_ENV=production\nUPDATE_SOURCE=external\n' > "$ENV_PATH"
    "$CHOWN_BIN" root:root "$ENV_PATH"
    "$CHMOD_BIN" 0600 "$ENV_PATH"
    printf 'github-deploy: add secrets to %s, then run the deployment again\n' "$ENV_PATH" >&2
    failure_code="environment-required"
    exit 2
  fi
  [[ -f "$ENV_PATH" && ! -L "$ENV_PATH" ]] || { failure_code="invalid-environment-file"; exit 2; }
  read -r owner group mode < <("$STAT_BIN" -c '%u %g %a' "$ENV_PATH") || { failure_code="invalid-environment-file"; exit 2; }
  [[ "$owner" == "0" && "$group" == "0" && "$mode" == "600" ]] || { failure_code="invalid-environment-file-permissions"; exit 2; }
  enforce_environment_assignment "$ENV_PATH" || exit 2
}

resolve_current_target() {
  local canonical
  [[ -L "$CURRENT_LINK" ]] || fail "current-release-missing"
  canonical="$($READLINK_BIN -f -- "$CURRENT_LINK")" || fail "current-release-missing"
  [[ -d "$canonical" && "$("$DIRNAME_BIN" "$canonical")" == "$RELEASES_DIR" ]] || fail "current-release-invalid"
  printf '%s' "$canonical"
}

resolve_current_tag() {
  local target="$1"
  local target_tag
  target_tag="$($GIT_BIN -C "$target" describe --tags --exact-match HEAD 2>/dev/null || true)"
  [[ "$target_tag" =~ $TAG_PATTERN ]] || fail "current-release-invalid"
  printf '%s' "$target_tag"
}

clone_and_build() {
  phase="clone"
  candidate_cleanup=0
  candidate_dir="$STAGING_DIR/candidate-${tag}-$$"
  [[ ! -e "$candidate_dir" ]] || fail "staging-directory-exists"
  candidate_cleanup=1
  "$RUNUSER_BIN" -u 9router -- "$MKDIR_BIN" "$candidate_dir" || fail "staging-create-failed"
  "$RUNUSER_BIN" -u 9router -- "$GIT_BIN" -C "$candidate_dir" init --quiet || fail "clone-failed"
  "$RUNUSER_BIN" -u 9router -- "$GIT_BIN" -C "$candidate_dir" remote add origin "$repository_url" || fail "clone-failed"
  "$RUNUSER_BIN" -u 9router -- "$GIT_BIN" -C "$candidate_dir" fetch --no-tags --depth 1 origin "refs/tags/$tag:refs/tags/$tag" || fail "clone-failed"
  "$RUNUSER_BIN" -u 9router -- "$GIT_BIN" -C "$candidate_dir" checkout --detach --force "refs/tags/$tag" || fail "clone-failed"
  local head_commit
  local tag_commit
  head_commit="$($GIT_BIN -C "$candidate_dir" rev-parse HEAD)" || fail "clone-failed"
  tag_commit="$($GIT_BIN -C "$candidate_dir" rev-parse "refs/tags/$tag^{commit}")" || fail "clone-failed"
  [[ "$head_commit" == "$tag_commit" ]] || fail "clone-failed"
  phase="build"
  if ! (cd "$candidate_dir" && "$RUNUSER_BIN" -u 9router -- "$NPM_BIN" ci && "$RUNUSER_BIN" -u 9router -- "$NPM_BIN" run build); then
    fail "build-failed"
  fi
  "$CHOWN_BIN" -R root:9router "$candidate_dir" || fail "release-ownership-failed"
  "$CHMOD_BIN" -R u=rwX,go=rX "$candidate_dir" || fail "release-ownership-failed"
}

promote_candidate() {
  local final_release
  final_release="$RELEASES_DIR/${tag}-$($DATE_BIN -u +%Y%m%dT%H%M%SZ)-$$"
  "$MV_BIN" -- "$candidate_dir" "$final_release" || fail "release-promote-failed"
  release_dir="$final_release"
  candidate_cleanup=0
}

health_check() {
  local health_file="$UPDATE_DIR/health.$$"
  local http_status
  local remaining
  local curl_timeout
  "$RM_BIN" -f -- "$health_file"
  local deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    curl_timeout=$((remaining < 2 ? remaining : 2))
    http_status="$($CURL_BIN --silent --show-error --output "$health_file" --write-out '%{http_code}' --max-time "$curl_timeout" "$HEALTH_URL" 2>/dev/null || true)"
    if [[ "$http_status" == "200" ]] && "$NODE_BIN" - "$health_file" >/dev/null 2>&1 <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (value.ok !== true) process.exit(1);
NODE
    then
      "$RM_BIN" -f -- "$health_file"
      return 0
    fi
    remaining=$((deadline - SECONDS))
    (( remaining > 0 )) || break
    "$SLEEP_BIN" "$((remaining < 1 ? remaining : 1))"
done
  "$RM_BIN" -f -- "$health_file"
  return 1
}

atomic_switch_to() {
  local target="$1"
  "$RM_BIN" -f -- "$CURRENT_NEW_LINK"
  "$LN_BIN" -s -- "$target" "$CURRENT_NEW_LINK"
  "$MV_BIN" -Tf -- "$CURRENT_NEW_LINK" "$CURRENT_LINK"
}

retain_releases() {
  local release
  for release in "$RELEASES_DIR"/*; do
    [[ -d "$release" ]] || continue
    [[ "$release" == "$release_dir" ]] && continue
    [[ -n "$previous_target" && "$release" == "$previous_target" ]] && continue
    "$RM_BIN" -rf -- "$release"
done
}

reject_existing_install() {
  [[ ! -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]] || fail "existing-deployment"
  [[ ! -e "$SERVICE_UNIT_PATH" ]] || fail "existing-deployment"
  if "$SYSTEMCTL_BIN" is-active --quiet "$SERVICE_NAME" || "$SYSTEMCTL_BIN" is-enabled --quiet "$SERVICE_NAME"; then
    fail "existing-deployment"
  fi
}

install_release() {
  ensure_account_and_directories
  ensure_environment
  reject_existing_install
  clone_and_build
  [[ -f "$candidate_dir/deploy/systemd/9router.service" ]] || fail "service-unit-missing"
  promote_candidate
  phase="service-install"
  "$INSTALL_BIN" -o root -g root -m 0644 "$release_dir/deploy/systemd/9router.service" "$SERVICE_UNIT_PATH" || fail "service-install-failed"
  "$SYSTEMCTL_BIN" daemon-reload || fail "daemon-reload-failed"
  atomic_switch_to "$release_dir" || fail "current-switch-failed"
  current_tag="$tag"
  "$SYSTEMCTL_BIN" enable "$SERVICE_NAME" || fail "service-enable-failed"
  phase="health-check"
  if ! "$SYSTEMCTL_BIN" start "$SERVICE_NAME" || ! health_check; then
    "$SYSTEMCTL_BIN" stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    fail "health-check-failed"
  fi
  phase="complete"
  write_status true ""
}

update_release() {
  ensure_account_and_directories
  ensure_environment
  phase="lock"
  "$MKDIR_BIN" "$LOCK_DIR" || fail "deployment-in-progress"
  lock_held=1
  previous_target="$(resolve_current_target)"
  previous_tag="$(resolve_current_tag "$previous_target")"
  current_tag="$previous_tag"
  if [[ "$previous_tag" == "$tag" ]]; then
    phase="complete"
    printf 'github-deploy: current already targets %s; unchanged\n' "$tag"
    write_status true ""
    return 0
  fi
  clone_and_build
  promote_candidate
  phase="stop-service"
  transaction_active=1
  "$SYSTEMCTL_BIN" stop "$SERVICE_NAME" || fail "service-stop-failed"
  phase="backup"
  backup_path="$BACKUP_DIR/$($DATE_BIN -u +%Y%m%dT%H%M%SZ)-${tag}.sqlite"
  if [[ -f "$DATABASE_FILE" ]]; then
    database_existed_before=1
    "$CP_BIN" -- "$DATABASE_FILE" "$backup_path" || fail "database-backup-failed"
    "$CHOWN_BIN" 9router:9router "$backup_path" || fail "database-backup-failed"
    "$CHMOD_BIN" 0600 "$backup_path" || fail "database-backup-failed"
    backup_ready=1
  fi
  phase="switch"
  atomic_switch_to "$release_dir" || fail "current-switch-failed"
  current_tag="$tag"
  phase="health-check"
  if ! "$SYSTEMCTL_BIN" start "$SERVICE_NAME"; then
    failure_code="service-start-failed"
    fail "$failure_code"
  fi
  if ! health_check; then
    failure_code="health-check-failed"
    fail "$failure_code"
  fi
  transaction_active=0
  phase="retention"
  retain_releases
  phase="complete"
  write_status true ""
}

deployment_started=1
if [[ "$operation" == "install" ]]; then
  install_release
else
  update_release
fi

exit 0
