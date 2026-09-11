#!/usr/bin/env bash
set -Eeuo pipefail

readonly DEFAULT_REPOSITORY_URL="https://github.com/glennprays/9router.git"
readonly DEPLOY_ROOT="/opt/9router"
readonly DATA_ROOT="/var/lib/9router"
readonly ENV_PATH="/etc/9router/9router.env"
readonly SERVICE_NAME="9router.service"
readonly SERVICE_UNIT_PATH="/etc/systemd/system/9router.service"
readonly HEALTH_URL="http://127.0.0.1:20128/api/health"
readonly HEALTH_TIMEOUT_MS=30000
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
readonly GROUPADD_BIN="/usr/sbin/groupadd"
readonly USERMOD_BIN="/usr/sbin/usermod"
readonly GETENT_BIN="/usr/bin/getent"
readonly STAT_BIN="/usr/bin/stat"
readonly MKDIR_BIN="/usr/bin/mkdir"
readonly RM_BIN="/usr/bin/rm"
readonly DIRNAME_BIN="/usr/bin/dirname"
readonly MV_BIN="/usr/bin/mv"
readonly LN_BIN="/usr/bin/ln"
readonly CP_BIN="/usr/bin/cp"
readonly CHOWN_BIN="/usr/bin/chown"
readonly CHMOD_BIN="/usr/bin/chmod"
readonly ENV_BIN="/usr/bin/env"
readonly CAT_BIN="/bin/cat"
readonly INSTALL_BIN="/usr/bin/install"
readonly RMDIR_BIN="/usr/bin/rmdir"
readonly DATE_BIN="/usr/bin/date"
readonly SLEEP_BIN="/usr/bin/sleep"
readonly CMP_BIN="/usr/bin/cmp"
readonly RELEASES_DIR="$DEPLOY_ROOT/releases"
readonly UPDATE_DIR="$DEPLOY_ROOT/update"
readonly STAGING_DIR="$UPDATE_DIR/staging"
readonly LOCK_DIR="$UPDATE_DIR/deploy.lock"
readonly CURRENT_LINK="$DEPLOY_ROOT/current"
readonly CURRENT_NEW_LINK="$DEPLOY_ROOT/current.new"
readonly RUNTIME_DIR="$DATA_ROOT/runtime"
readonly DATABASE_DIR="$DATA_ROOT/db"
readonly DATABASE_FILE="$DATABASE_DIR/data.sqlite"
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
release_promoted=0
unit_installed=0
service_enabled=0
current_switched=0
stop_confirmed=0
database_state_known=0
release_dir=""
candidate_dir=""
current_tag=""
stop_confirmation_failed=0
previous_target=""
previous_tag=""
backup_path=""
database_existed_before=0
NPM_HOME=""
NPM_CACHE=""
npm_home=""
npm_cache=""

usage() {
  printf '%s\n' \
    'Usage:' \
    '  sudo bash deploy/github-deploy.sh install --tag v0.5.70' \
    '  sudo bash deploy/github-deploy.sh update --tag v0.5.71' \
    '  sudo bash deploy/github-deploy.sh --help' \
    '' \
    'Install or update 9Router from an exact tag in the configured GitHub repository.'
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
    --help) argument_error "--help must be used by itself" ;;
    *) argument_error "unknown argument" ;;
  esac
done
[[ -n "$tag" ]] || argument_error "--tag is required"
[[ "$tag" =~ $TAG_PATTERN ]] || argument_error "tag must be a release tag such as v0.5.70"
[[ "$repository_url" =~ ^https://github\.com/[^/]+/[^/]+\.git$ ]] || argument_error "repository URL must be an HTTPS GitHub .git URL"
[[ "$EUID" -eq 0 ]] || argument_error "install and update require root"
for prerequisite in \
  "$GIT_BIN" "$NODE_BIN" "$NPM_BIN" "$CURL_BIN" "$SYSTEMCTL_BIN" "$READLINK_BIN" \
  "$RUNUSER_BIN" "$ID_BIN" "$USERADD_BIN" "$GROUPADD_BIN" "$USERMOD_BIN" "$GETENT_BIN" "$STAT_BIN" \
  "$MKDIR_BIN" "$RM_BIN" "$DIRNAME_BIN" "$MV_BIN" "$LN_BIN" "$CP_BIN" "$CHOWN_BIN" "$CHMOD_BIN" \
  "$INSTALL_BIN" "$RMDIR_BIN" "$DATE_BIN" "$SLEEP_BIN" "$ENV_BIN" "$CMP_BIN"; do
  [[ -x "$prerequisite" ]] || argument_error "missing prerequisite: $prerequisite"
done
started_at="$($DATE_BIN -u +%Y-%m-%dT%H:%M:%SZ)"

status_value() {
  if [[ -n "$1" ]]; then printf '"%s"' "$1"; else printf 'null'; fi
}

write_status() {
  local success="$1" error="$2" finished_at status_tmp
  finished_at="$($DATE_BIN -u +%Y-%m-%dT%H:%M:%SZ)"
  status_tmp="$UPDATE_DIR/status.json.new.$$"
  [[ -d "$UPDATE_DIR" && ! -L "$UPDATE_DIR" ]] || return 1
  if [[ -n "$error" ]]; then error="\"$error\""; else error="null"; fi
  printf '{"phase":"%s","tag":"%s","currentTag":%s,"previousTag":%s,"startedAt":"%s","finishedAt":"%s","success":%s,"error":%s}\n' \
    "$phase" "$tag" "$(status_value "$current_tag")" "$(status_value "$previous_tag")" \
    "$started_at" "$finished_at" "$success" "$error" > "$status_tmp"
  "$CHMOD_BIN" 0600 "$status_tmp"
  "$CHOWN_BIN" root:root "$status_tmp"
  "$MV_BIN" -Tf -- "$status_tmp" "$UPDATE_DIR/status.json"
  status_record_written=1
}

write_failure_log() {
  local timestamp log_file
  timestamp="$($DATE_BIN -u +%Y%m%dT%H%M%SZ)"
  log_file="$UPDATE_DIR/failure-${timestamp}-${tag}-$$.log"
  printf 'phase=%s\ntag=%s\ncurrentTag=%s\npreviousTag=%s\nerror=%s\n' \
    "$phase" "$tag" "${current_tag:-unknown}" "${previous_tag:-unknown}" "$failure_code" > "$log_file"
  "$CHMOD_BIN" 0600 "$log_file" 2>/dev/null || true
  "$CHOWN_BIN" root:root "$log_file" 2>/dev/null || true
}

release_lock() {
  if [[ "$lock_held" -eq 1 ]]; then
    "$RMDIR_BIN" "$LOCK_DIR" 2>/dev/null || true
    lock_held=0
  fi
}

check_directory_entry() {
  local path="$1"
  [[ ! -L "$path" && ( ! -e "$path" || -d "$path" ) ]]
}

validate_directory_entry() {
  local path="$1"
  check_directory_entry "$path" || fail "managed-path-invalid"
}

validate_regular_database() {
  [[ ! -L "$DATABASE_FILE" ]] || return 1
  if [[ -e "$DATABASE_FILE" ]]; then
    [[ -f "$DATABASE_FILE" ]] || return 1
    [[ "$("$STAT_BIN" -c '%F' "$DATABASE_FILE")" == "regular file" ]] || return 1
  fi
}

capture_database_state() {
  validate_directory_entry "$DATA_ROOT"
  validate_directory_entry "$DATABASE_DIR"
  validate_regular_database || fail "database-invalid"
  if [[ -e "$DATABASE_FILE" ]]; then database_existed_before=1; else database_existed_before=0; fi
  database_state_known=1
}

validate_database_after_stop() {
  check_directory_entry "$DATA_ROOT" || return 1
  check_directory_entry "$DATABASE_DIR" || return 1
  validate_regular_database || return 1
  database_state_known=1
}
remove_new_database() {
  validate_database_after_stop || return 1
  if [[ -e "$DATABASE_FILE" ]]; then
    [[ ! -L "$DATABASE_FILE" && -f "$DATABASE_FILE" ]] || return 1
    "$RM_BIN" -f -- "$DATABASE_FILE"
  fi
}


service_state_is_stopped() {
  local state
  state="$("$SYSTEMCTL_BIN" show "$SERVICE_NAME" --property=ActiveState --value 2>/dev/null)" || return 1
  [[ "$state" == "inactive" || "$state" == "failed" ]]
}

stop_service_confirmed() {
  if ! "$SYSTEMCTL_BIN" stop "$SERVICE_NAME" >/dev/null 2>&1; then
    stop_confirmation_failed=1
    return 1
  fi
  if ! service_state_is_stopped; then
    stop_confirmation_failed=1
    return 1
  fi
  stop_confirmed=1
}

safe_remove_symlink() {
  local path="$1"
  [[ ! -e "$path" && ! -L "$path" ]] && return 0
  [[ -L "$path" ]] || return 1
  "$RM_BIN" -f -- "$path"
}
remove_installed_unit() {
  [[ -f "$SERVICE_UNIT_PATH" && ! -L "$SERVICE_UNIT_PATH" ]] || return 1
  "$RM_BIN" -f -- "$SERVICE_UNIT_PATH"
}

restore_database() {
  local restore_tmp="$DATABASE_FILE.restore.$$"
  [[ "$stop_confirmed" -eq 1 && "$database_state_known" -eq 1 ]] || return 1
  [[ -n "$backup_path" && "$backup_ready" -eq 1 ]] || return 1
  [[ -f "$backup_path" && ! -L "$backup_path" ]] || return 1
  validate_database_after_stop || return 1
  [[ ! -e "$restore_tmp" && ! -L "$restore_tmp" ]] || return 1
  # cp creates this temporary file as root; ownership and mode are changed before
  # the no-follow-safe atomic replacement of the service database.
  "$CP_BIN" -- "$backup_path" "$restore_tmp" || return 1
  "$CHOWN_BIN" 9router:9router "$restore_tmp" || return 1
  "$CHMOD_BIN" 0600 "$restore_tmp" || return 1
  [[ -f "$restore_tmp" && ! -L "$restore_tmp" ]] || return 1
  validate_database_after_stop || return 1
  "$MV_BIN" -Tf -- "$restore_tmp" "$DATABASE_FILE" || return 1
  validate_regular_database
}

preserve_failed_release() {
  local timestamp failed_target
  [[ "$release_promoted" -eq 1 && -n "$release_dir" ]] || return 0
  [[ -d "$release_dir" && ! -L "$release_dir" ]] || return 0
  timestamp="$($DATE_BIN -u +%Y%m%dT%H%M%SZ)"
  failed_target="$RELEASES_DIR/${tag}.failed-${timestamp}-$$"
  [[ ! -e "$failed_target" && ! -L "$failed_target" ]] || return 1
  "$MV_BIN" -T -- "$release_dir" "$failed_target"
  release_dir="$failed_target"
  release_promoted=0
}

rollback_update() {
  local rollback_failed=0 stop_ok=0
  phase="rollback"
  rollback_attempted=1
  # Database mutation and service restart require a successful stop plus a
  # confirmed inactive/failed state. Unknown service state is fail-closed.
  if stop_service_confirmed && [[ "$stop_confirmation_failed" -eq 0 ]]; then
    stop_ok=1
  else
    rollback_failed=1
  fi
  safe_remove_symlink "$CURRENT_NEW_LINK" || rollback_failed=1
  if [[ "$stop_ok" -eq 1 && -n "$previous_target" && -d "$previous_target" && ! -L "$previous_target" ]]; then
    if ! "$LN_BIN" -s -- "$previous_target" "$CURRENT_NEW_LINK" || ! "$MV_BIN" -Tf -- "$CURRENT_NEW_LINK" "$CURRENT_LINK"; then
      rollback_failed=1
    else
      current_switched=0
      current_tag="$previous_tag"
    fi
  elif [[ "$stop_ok" -eq 1 ]]; then
    rollback_failed=1
  fi
  if [[ "$stop_ok" -eq 1 && "$database_state_known" -eq 1 ]]; then
    if [[ "$backup_ready" -eq 1 ]]; then
      restore_database || rollback_failed=1
    elif [[ "$database_existed_before" -eq 0 ]]; then
      remove_new_database || rollback_failed=1
    fi
  fi
  # Never claim a restart when stop was not confirmed.
  if [[ "$stop_ok" -eq 1 ]]; then
    "$SYSTEMCTL_BIN" start "$SERVICE_NAME" >/dev/null 2>&1 || rollback_failed=1
  fi
  transaction_active=0
  if [[ "$rollback_failed" -eq 1 ]]; then failure_code="rollback-failed"; fi
  return "$rollback_failed"
}

rollback_first_install() {
  local rollback_failed=0 stop_ok=0
  phase="rollback"
  rollback_attempted=1
  # Stop and confirm before deleting a database created by a failed first install.
  if [[ "$service_enabled" -eq 1 ]]; then
    if stop_service_confirmed && [[ "$stop_confirmation_failed" -eq 0 ]]; then stop_ok=1; else rollback_failed=1; fi
  else
    stop_ok=1
  fi
  if [[ "$unit_installed" -eq 1 || "$service_enabled" -eq 1 ]]; then
    "$SYSTEMCTL_BIN" disable "$SERVICE_NAME" >/dev/null 2>&1 || rollback_failed=1
    remove_installed_unit || rollback_failed=1
    "$SYSTEMCTL_BIN" daemon-reload >/dev/null 2>&1 || rollback_failed=1
  fi
  if [[ "$current_switched" -eq 1 ]]; then
    if [[ "$stop_ok" -eq 1 ]]; then
      safe_remove_symlink "$CURRENT_LINK" || rollback_failed=1
      current_tag=""
    else
      rollback_failed=1
    fi
  fi
  if [[ "$stop_confirmed" -eq 1 && "$stop_confirmation_failed" -eq 0 && "$database_state_known" -eq 1 && "$database_existed_before" -eq 0 ]]; then
    remove_new_database || rollback_failed=1
  fi
  transaction_active=0
  if [[ "$rollback_failed" -eq 1 ]]; then failure_code="rollback-failed"; fi
  return "$rollback_failed"
}


on_exit() {
  local exit_code=$? original_failure rollback_result
  trap - EXIT
  if [[ "$exit_code" -ne 0 ]]; then
    original_failure="$failure_code"
    if [[ "$transaction_active" -eq 1 && "$rollback_attempted" -eq 0 ]]; then
      if [[ "$operation" == "install" ]]; then rollback_first_install; else rollback_update; fi
      rollback_result=$?
      failure_code="$original_failure"
      [[ "$rollback_result" -eq 0 ]] || failure_code="rollback-failed"
    fi
    # A promoted candidate is always preserved after post-promotion failure.
    preserve_failed_release 2>/dev/null || true
    if [[ "$candidate_cleanup" -eq 1 && -n "$candidate_dir" && -d "$candidate_dir" && ! -L "$candidate_dir" ]]; then
      "$RM_BIN" -rf -- "$candidate_dir" 2>/dev/null || true
    fi
    if [[ "$deployment_started" -eq 1 && -d "$UPDATE_DIR" && ! -L "$UPDATE_DIR" ]]; then
      write_failure_log 2>/dev/null || true
      if [[ "$status_record_written" -eq 0 ]]; then write_status false "$failure_code" 2>/dev/null || true; fi
    fi
  fi
  release_lock
  exit "$exit_code"
}
trap on_exit EXIT

enforce_environment_assignment() {
  local file="$1" line key value seen_data=0 seen_port=0 seen_source=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || { failure_code="invalid-environment-file"; return 1; }
    [[ -z "${BASH_REMATCH[1]}" ]] || { failure_code="invalid-environment-file"; return 1; }
    key="${BASH_REMATCH[2]}"; value="${BASH_REMATCH[3]}"
    value="${value#"${value%%[![:space:]]*}"}"; value="${value%"${value##*[![:space:]]}"}"
    case "$key" in
      DATA_DIR) [[ "$seen_data" -eq 0 ]] || { failure_code="environment-duplicate-data-dir"; return 1; }; seen_data=1; [[ "$value" == "$DATA_ROOT" ]] || { failure_code="environment-data-dir-mismatch"; return 1; } ;;
      PORT) [[ "$seen_port" -eq 0 ]] || { failure_code="environment-duplicate-port"; return 1; }; seen_port=1; [[ "$value" == "20128" ]] || { failure_code="environment-port-mismatch"; return 1; } ;;
      UPDATE_SOURCE) [[ "$seen_source" -eq 0 ]] || { failure_code="environment-duplicate-update-source"; return 1; }; seen_source=1; [[ "$value" == "external" ]] || { failure_code="environment-update-source-mismatch"; return 1; } ;;
    esac
  done < "$file"
  [[ "$seen_data" -eq 1 ]] || { failure_code="environment-data-dir-missing"; return 1; }
  [[ "$seen_port" -eq 1 ]] || { failure_code="environment-port-missing"; return 1; }
  [[ "$seen_source" -eq 1 ]] || { failure_code="environment-update-source-missing"; return 1; }
}

ensure_account() {
  if ! "$ID_BIN" -u 9router >/dev/null 2>&1; then
    if "$GETENT_BIN" group 9router >/dev/null 2>&1; then
      "$USERADD_BIN" --system --gid 9router --home-dir "$DATA_ROOT" --shell /usr/sbin/nologin 9router || fail "account-creation-failed"
    else
      "$USERADD_BIN" --system --user-group --home-dir "$DATA_ROOT" --shell /usr/sbin/nologin 9router || fail "account-creation-failed"
    fi
  fi
  if ! "$GETENT_BIN" group 9router >/dev/null 2>&1; then
    "$GROUPADD_BIN" --system 9router || fail "group-creation-failed"
  fi
  local primary_group
  primary_group="$($ID_BIN -gn 9router 2>/dev/null)" || fail "account-query-failed"
  if [[ "$primary_group" != "9router" ]]; then
    "$USERMOD_BIN" --gid 9router 9router || fail "account-group-failed"
  fi
}

validate_managed_tree() {
  local path
  for path in /opt /opt/9router /opt/9router/releases /opt/9router/update /opt/9router/update/staging \
    /var /var/lib /var/lib/9router /var/lib/9router/runtime /var/lib/9router/db /var/lib/9router/backups \
    /etc /etc/9router /etc/systemd /etc/systemd/system; do
    validate_directory_entry "$path"
  done
}

ensure_directory_tree() {
  # Check each ancestor immediately before creating or changing its child.
  local path
  for path in /opt /opt/9router "$RELEASES_DIR" "$UPDATE_DIR" "$STAGING_DIR" \
    /var /var/lib "$DATA_ROOT" "$RUNTIME_DIR" "$DATABASE_DIR" "$BACKUP_DIR" \
    /etc /etc/9router; do
    validate_directory_entry "$path"
    if [[ ! -e "$path" ]]; then "$MKDIR_BIN" "$path"; fi
    validate_directory_entry "$path"
  done
  "$CHOWN_BIN" root:root "$DEPLOY_ROOT" "$RELEASES_DIR" "$UPDATE_DIR" "$STAGING_DIR" \
    "$DATA_ROOT" "$RUNTIME_DIR" "$BACKUP_DIR" /etc/9router
  "$CHMOD_BIN" 0755 "$DEPLOY_ROOT" "$RELEASES_DIR" "$DATA_ROOT" /etc/9router
  "$CHMOD_BIN" 0755 "$UPDATE_DIR" "$STAGING_DIR"
  "$CHMOD_BIN" 0700 "$RUNTIME_DIR" "$BACKUP_DIR"
  "$CHOWN_BIN" 9router:9router "$DATABASE_DIR"
  "$CHMOD_BIN" 0750 "$DATABASE_DIR"
}

ensure_account_and_directories() {
  phase="prepare"
  validate_managed_tree
  ensure_account
  ensure_directory_tree
}
ensure_environment() {
  local owner group mode
  [[ ! -L "$ENV_PATH" ]] || { failure_code="invalid-environment-file"; exit 2; }
  if [[ ! -e "$ENV_PATH" ]]; then
    umask 077
    printf 'DATA_DIR=/var/lib/9router\nPORT=20128\nNODE_ENV=production\nUPDATE_SOURCE=external\n' > "$ENV_PATH"
    "$CHOWN_BIN" root:root "$ENV_PATH"; "$CHMOD_BIN" 0600 "$ENV_PATH"
    printf 'github-deploy: add secrets to %s, then run the deployment again\n' "$ENV_PATH" >&2
    failure_code="environment-required"; exit 2
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
  [[ -d "$canonical" && ! -L "$canonical" && "$($DIRNAME_BIN "$canonical")" == "$RELEASES_DIR" ]] || fail "current-release-invalid"
  printf '%s' "$canonical"
}

resolve_current_tag() {
  local target="$1" target_tag
  target_tag="$("$GIT_BIN" -C "$target" describe --tags --exact-match HEAD 2>/dev/null || true)"
  [[ "$target_tag" =~ $TAG_PATTERN ]] || fail "current-release-invalid"
  printf '%s' "$target_tag"
}

clone_and_build() {
  phase="clone"
  candidate_cleanup=0
  candidate_dir="$STAGING_DIR/candidate-${tag}-$$"
  [[ ! -e "$candidate_dir" && ! -L "$candidate_dir" ]] || fail "staging-directory-exists"
  "$MKDIR_BIN" "$candidate_dir"
  "$CHOWN_BIN" 9router:9router "$candidate_dir"
  "$CHMOD_BIN" 0700 "$candidate_dir"
  candidate_cleanup=1
  NPM_HOME="$candidate_dir/npm-home"; NPM_CACHE="$candidate_dir/npm-cache"
  "$MKDIR_BIN" "$NPM_HOME" "$NPM_CACHE"
  "$CHOWN_BIN" 9router:9router "$NPM_HOME" "$NPM_CACHE"
  "$CHMOD_BIN" 0700 "$NPM_HOME" "$NPM_CACHE"
  "$RUNUSER_BIN" -u 9router -- "$GIT_BIN" -C "$candidate_dir" init --quiet || fail "clone-failed"
  "$RUNUSER_BIN" -u 9router -- "$GIT_BIN" -C "$candidate_dir" remote add origin "$repository_url" || fail "clone-failed"
  "$RUNUSER_BIN" -u 9router -- "$GIT_BIN" -C "$candidate_dir" fetch --no-tags --depth 1 origin "refs/tags/$tag:refs/tags/$tag" || fail "clone-failed"
  "$RUNUSER_BIN" -u 9router -- "$GIT_BIN" -C "$candidate_dir" checkout --detach --force "refs/tags/$tag" || fail "clone-failed"
  local head_commit tag_commit
  head_commit="$($GIT_BIN -C "$candidate_dir" rev-parse HEAD)" || fail "clone-failed"
  tag_commit="$($GIT_BIN -C "$candidate_dir" rev-parse "refs/tags/$tag^{commit}")" || fail "clone-failed"
  [[ "$head_commit" == "$tag_commit" ]] || fail "clone-failed"
  phase="build"
  if ! (cd "$candidate_dir" && \
    "$RUNUSER_BIN" -u 9router -- "$ENV_BIN" -i "HOME=$NPM_HOME" "npm_config_cache=$NPM_CACHE" "npm_config_userconfig=$NPM_HOME/npmrc" "npm_config_globalconfig=/dev/null" "PATH=/usr/bin:/bin" "$NPM_BIN" ci && \
    "$RUNUSER_BIN" -u 9router -- "$ENV_BIN" -i "HOME=$NPM_HOME" "npm_config_cache=$NPM_CACHE" "npm_config_userconfig=$NPM_HOME/npmrc" "npm_config_globalconfig=/dev/null" "PATH=/usr/bin:/bin" "$NPM_BIN" run build); then
    fail "build-failed"
  fi
  "$CHOWN_BIN" -R --no-dereference root:9router "$candidate_dir" || fail "release-ownership-failed"
  "$CHMOD_BIN" -R u=rwX,go=rX "$candidate_dir" || fail "release-ownership-failed"
}

expected_service_unit() {
  "$CAT_BIN" <<'EOF'
[Unit]
Description=9Router fork
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=9router
Group=9router
WorkingDirectory=/opt/9router/current
EnvironmentFile=/etc/9router/9router.env
ExecStart=/usr/bin/node /opt/9router/current/.next/standalone/custom-server.js
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
}

validate_service_unit() {
  local candidate="$candidate_dir/deploy/systemd/9router.service" expected="$UPDATE_DIR/service-unit.expected.$$"
  [[ -f "$candidate" && ! -L "$candidate" ]] || fail "service-unit-missing"
  expected_service_unit > "$expected"
  "$CHMOD_BIN" 0600 "$expected"; "$CHOWN_BIN" root:root "$expected"
  "$CMP_BIN" -s "$candidate" "$expected" || { "$RM_BIN" -f -- "$expected"; fail "service-unit-invalid"; }
  "$RM_BIN" -f -- "$expected"
}

promote_candidate() {
  local final_release="$RELEASES_DIR/$tag"
  [[ ! -e "$final_release" && ! -L "$final_release" ]] || fail "release-collision"
  "$MV_BIN" -T -- "$candidate_dir" "$final_release" || fail "release-promote-failed"
  release_dir="$final_release"; candidate_cleanup=0; release_promoted=1
}

monotonic_milliseconds() {
  local uptime_seconds whole_seconds fractional_seconds
  IFS=' ' read -r uptime_seconds _ < /proc/uptime || return 1
  [[ "$uptime_seconds" =~ ^([0-9]+)\.([0-9]+)$ ]] || return 1
  whole_seconds="${BASH_REMATCH[1]}"; fractional_seconds="${BASH_REMATCH[2]}000"; fractional_seconds="${fractional_seconds:0:3}"
  printf '%s' "$((10#$whole_seconds * 1000 + 10#$fractional_seconds))"
}

health_check() {
  local health_file="$UPDATE_DIR/health.$$" http_status deadline_ms now_ms remaining_ms curl_timeout sleep_seconds
  "$RM_BIN" -f -- "$health_file"
  now_ms="$(monotonic_milliseconds)" || return 1; deadline_ms=$((now_ms + HEALTH_TIMEOUT_MS))
  while :; do
    now_ms="$(monotonic_milliseconds)" || break; remaining_ms=$((deadline_ms - now_ms)); (( remaining_ms > 0 )) || break
    curl_timeout="$(printf '%d.%03d' "$((remaining_ms / 1000))" "$((remaining_ms % 1000))")"
    http_status="$($CURL_BIN --silent --show-error --output "$health_file" --write-out '%{http_code}' --max-time "$curl_timeout" "$HEALTH_URL" 2>/dev/null || true)"
    if [[ "$http_status" == "200" ]] && "$NODE_BIN" - "$health_file" >/dev/null 2>&1 <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (value.ok !== true) process.exit(1);
NODE
    then "$RM_BIN" -f -- "$health_file"; return 0; fi
    now_ms="$(monotonic_milliseconds)" || break; remaining_ms=$((deadline_ms - now_ms)); (( remaining_ms > 0 )) || break
    if (( remaining_ms < 1000 )); then sleep_seconds="$(printf '0.%03d' "$remaining_ms")"; else sleep_seconds="1"; fi
    "$SLEEP_BIN" "$sleep_seconds"
  done
  "$RM_BIN" -f -- "$health_file"; return 1
}

atomic_switch_to() {
  local target="$1"
  [[ -d "$target" && ! -L "$target" && "$($DIRNAME_BIN "$target")" == "$RELEASES_DIR" ]] || return 1
  safe_remove_symlink "$CURRENT_NEW_LINK" || return 1
  "$LN_BIN" -s -- "$target" "$CURRENT_NEW_LINK"
  "$MV_BIN" -Tf -- "$CURRENT_NEW_LINK" "$CURRENT_LINK"
  current_switched=1
}

retain_releases() {
  local release name
  for release in "$RELEASES_DIR"/*; do
    [[ -d "$release" && ! -L "$release" ]] || continue
    [[ "$release" == "$release_dir" || ( -n "$previous_target" && "$release" == "$previous_target" ) ]] && continue
    name="${release##*/}"
    [[ "$name" == *.failed-* ]] && continue
    [[ "$name" =~ $TAG_PATTERN ]] || continue
    "$RM_BIN" -rf -- "$release"
done
}

retain_backups() {
  local backup name
  [[ -n "$backup_path" ]] || return 0
  validate_directory_entry "$BACKUP_DIR" || return 1
  for backup in "$BACKUP_DIR"/*.sqlite; do
    [[ -f "$backup" && ! -L "$backup" ]] || continue
    [[ "$backup" == "$backup_path" ]] && continue
    name="${backup##*/}"
    [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z-v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?\.sqlite$ ]] || continue
    "$RM_BIN" -f -- "$backup"
  done
}

reject_existing_install() {
  [[ ! -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]] || fail "existing-deployment"
  [[ ! -e "$SERVICE_UNIT_PATH" && ! -L "$SERVICE_UNIT_PATH" ]] || fail "existing-deployment"
  local load_state
  load_state="$("$SYSTEMCTL_BIN" show "$SERVICE_NAME" --property=LoadState --value 2>/dev/null)" || fail "service-query-failed"
  case "$load_state" in
    not-found) ;;
    *) fail "existing-deployment" ;;
  esac
}

install_release() {
  ensure_account_and_directories
  ensure_environment
  reject_existing_install
  capture_database_state
  clone_and_build; validate_service_unit; promote_candidate
  transaction_active=1; phase="service-install"
  local expected="$UPDATE_DIR/service-unit.expected-install.$$"
  expected_service_unit > "$expected"; "$CHMOD_BIN" 0600 "$expected"; "$CHOWN_BIN" root:root "$expected"
  "$INSTALL_BIN" -o root -g root -m 0644 "$expected" "$SERVICE_UNIT_PATH" || fail "service-install-failed"
  unit_installed=1
  "$RM_BIN" -f -- "$expected"
  "$SYSTEMCTL_BIN" daemon-reload || fail "daemon-reload-failed"
  atomic_switch_to "$release_dir" || fail "current-switch-failed"; current_tag="$tag"
  "$SYSTEMCTL_BIN" enable "$SERVICE_NAME" || fail "service-enable-failed"; service_enabled=1
  phase="health-check"
  "$SYSTEMCTL_BIN" start "$SERVICE_NAME" || fail "service-start-failed"
  health_check || fail "health-check-failed"
  phase="retention"; retain_releases; retain_backups
  phase="complete"; write_status true ""; transaction_active=0
}

update_release() {
  ensure_account_and_directories; ensure_environment
  phase="lock"; "$MKDIR_BIN" "$LOCK_DIR" || fail "deployment-in-progress"; lock_held=1
  previous_target="$(resolve_current_target)"; previous_tag="$(resolve_current_tag "$previous_target")"; current_tag="$previous_tag"
  if [[ "$previous_tag" == "$tag" ]]; then phase="complete"; printf 'github-deploy: current already targets %s; unchanged\n' "$tag"; write_status true ""; return 0; fi
  clone_and_build; promote_candidate
  phase="stop-service"; transaction_active=1
  capture_database_state
  stop_service_confirmed || fail "service-stop-failed"
  phase="backup"; validate_database_after_stop || fail "database-backup-failed"; validate_directory_entry "$BACKUP_DIR" || fail "database-backup-failed"
  backup_path="$BACKUP_DIR/$($DATE_BIN -u +%Y%m%dT%H%M%SZ)-${tag}.sqlite"
  if [[ "$database_existed_before" -eq 1 ]]; then
    [[ -f "$DATABASE_FILE" && ! -L "$DATABASE_FILE" ]] || fail "database-backup-failed"
    [[ ! -e "$backup_path" && ! -L "$backup_path" ]] || fail "database-backup-failed"
    "$CP_BIN" -- "$DATABASE_FILE" "$backup_path" || fail "database-backup-failed"
    "$CHOWN_BIN" root:root "$backup_path" || fail "database-backup-failed"
    "$CHMOD_BIN" 0600 "$backup_path" || fail "database-backup-failed"
    backup_ready=1
  else
    [[ ! -e "$DATABASE_FILE" || ( -f "$DATABASE_FILE" && ! -L "$DATABASE_FILE" ) ]] || fail "database-backup-failed"
  fi
  phase="switch"; atomic_switch_to "$release_dir" || fail "current-switch-failed"; current_tag="$tag"
  phase="health-check"; "$SYSTEMCTL_BIN" start "$SERVICE_NAME" || fail "service-start-failed"; health_check || fail "health-check-failed"
  phase="retention"; retain_releases; retain_backups
  phase="complete"; write_status true ""; transaction_active=0
}

deployment_started=1
if [[ "$operation" == "install" ]]; then install_release; else update_release; fi
exit 0
