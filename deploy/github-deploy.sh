#!/usr/bin/env bash
set -Eeuo pipefail

readonly DEFAULT_REPOSITORY_URL="https://github.com/glennprays/9router.git"
readonly UPDATE_ROOT="${UPDATE_ROOT:-/opt/9router}"
readonly DATA_DIR="${DATA_DIR:-/var/lib/9router}"
readonly ENV_FILE="${ENV_FILE:-/etc/9router/9router.env}"
readonly SERVICE_NAME="9router.service"
readonly HEALTH_URL="http://127.0.0.1:20128/api/health"
readonly TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$'

operation=""
tag=""
repository_url="${NINEROUTER_REPOSITORY_URL:-$DEFAULT_REPOSITORY_URL}"
phase="arguments"
failure_code="deployment-failed"
status_record_written=0
lock_held=0
candidate_cleanup=0
release_dir=""
current_tag=""
previous_tag=""
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

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

resolve_command() {
  local name="$1"
  local resolved
  resolved="$(command -v "$name" 2>/dev/null || true)"
  [[ -n "$resolved" && -x "$resolved" ]] || argument_error "missing prerequisite: $name"
  printf '%s' "$resolved"
}

GIT_BIN="$(resolve_command git)"
NODE_BIN="$(resolve_command node)"
NPM_BIN="$(resolve_command npm)"
CURL_BIN="$(resolve_command curl)"
SYSTEMCTL_BIN="$(resolve_command systemctl)"
READLINK_BIN="$(resolve_command readlink)"

readonly GIT_BIN NODE_BIN NPM_BIN CURL_BIN SYSTEMCTL_BIN READLINK_BIN
readonly RELEASES_DIR="$UPDATE_ROOT/releases"
readonly UPDATE_DIR="$UPDATE_ROOT/update"
readonly LOCK_DIR="$UPDATE_DIR/deploy.lock"
readonly CURRENT_LINK="$UPDATE_ROOT/current"
readonly CURRENT_NEW_LINK="$UPDATE_ROOT/current.new"
readonly DATABASE_FILE="$DATA_DIR/db/data.sqlite"
readonly BACKUP_DIR="$DATA_DIR/backups"

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
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  status_tmp="$UPDATE_DIR/status.json.new.$$"
  mkdir -p "$UPDATE_DIR"
  if [[ -n "$error" ]]; then
    error="\"$error\""
  else
    error="null"
  fi
  printf '{"phase":"%s","tag":"%s","currentTag":%s,"previousTag":%s,"startedAt":"%s","finishedAt":"%s","success":%s,"error":%s}\n' \
    "$phase" "$tag" "$(status_value "$current_tag")" "$(status_value "$previous_tag")" \
    "$started_at" "$finished_at" "$success" "$error" > "$status_tmp"
  mv -f -- "$status_tmp" "$UPDATE_DIR/status.json"
  status_record_written=1
}

write_failure_log() {
  local timestamp
  local log_file
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  log_file="$UPDATE_DIR/failure-${timestamp}-${tag}.log"
  printf 'phase=%s\ntag=%s\ncurrentTag=%s\npreviousTag=%s\nerror=%s\n' \
    "$phase" "$tag" "${current_tag:-unknown}" "${previous_tag:-unknown}" "$failure_code" > "$log_file"
  chmod 0600 "$log_file" 2>/dev/null || true
}

release_lock() {
  if [[ "$lock_held" -eq 1 ]]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
    lock_held=0
  fi
}

on_exit() {
  local exit_code=$?
  trap - EXIT
  if [[ "$exit_code" -ne 0 ]]; then
    if [[ "$candidate_cleanup" -eq 1 && -n "$release_dir" && -d "$release_dir" ]]; then
      rm -rf -- "$release_dir" 2>/dev/null || true
    fi
    if [[ -d "$UPDATE_DIR" ]]; then
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

ensure_account_and_directories() {
  phase="prepare"
  if ! /usr/bin/id -u 9router >/dev/null 2>&1; then
    /usr/sbin/useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin 9router || fail "account-creation-failed"
  fi
  mkdir -p "$RELEASES_DIR" "$UPDATE_DIR" "$DATA_DIR/db" "$BACKUP_DIR" /etc/9router
  chmod 0755 "$UPDATE_ROOT" "$RELEASES_DIR" /etc/9router
  chmod 0700 "$UPDATE_DIR"
  chmod 0750 "$DATA_DIR" "$DATA_DIR/db" "$BACKUP_DIR"
  chown root:root "$UPDATE_ROOT" "$RELEASES_DIR" "$UPDATE_DIR" /etc/9router
  chown 9router:9router "$DATA_DIR" "$DATA_DIR/db" "$BACKUP_DIR"
}

ensure_environment() {
  phase="environment"
  if [[ ! -e "$ENV_FILE" ]]; then
    umask 077
    printf 'DATA_DIR=/var/lib/9router\nPORT=20128\nNODE_ENV=production\nUPDATE_SOURCE=external\n' > "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
    printf 'github-deploy: add secrets to %s, then run the deployment again\n' "$ENV_FILE" >&2
    failure_code="environment-required"
    exit 2
  fi
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || { failure_code="invalid-environment-file"; exit 2; }
  grep -Fqx 'DATA_DIR=/var/lib/9router' "$ENV_FILE" || { failure_code="environment-data-dir-mismatch"; exit 2; }
  grep -Fqx 'UPDATE_SOURCE=external' "$ENV_FILE" || { failure_code="environment-update-source-mismatch"; exit 2; }
}

resolve_current_target() {
  local target
  [[ -L "$CURRENT_LINK" ]] || fail "current-release-missing"
  target="$("$READLINK_BIN" "$CURRENT_LINK")"
  if [[ "$target" != /* ]]; then
    target="$UPDATE_ROOT/$target"
  fi
  [[ -d "$target" ]] || fail "current-release-missing"
  printf '%s' "$target"
}

clone_and_build() {
  phase="clone"
  release_dir="$RELEASES_DIR/$tag"
  candidate_cleanup=0
  if [[ -e "$release_dir" || -L "$release_dir" ]]; then
    [[ -d "$release_dir/.git" ]] || fail "existing-release-mismatch"
    local existing_tag
    existing_tag="$("$GIT_BIN" -C "$release_dir" describe --tags --exact-match HEAD 2>/dev/null || true)"
    [[ "$existing_tag" == "$tag" ]] || fail "existing-release-mismatch"
  else
    candidate_cleanup=1
    "$GIT_BIN" clone --depth 1 --branch "$tag" "$repository_url" "$release_dir" || fail "clone-failed"
  fi
  phase="build"
  if ! (cd "$release_dir" && "$NPM_BIN" ci && "$NPM_BIN" run build); then
    fail "build-failed"
  fi
}

health_check() {
  local health_file="$UPDATE_DIR/health.$$"
  local http_status
  local attempt
  for ((attempt = 0; attempt < 30; attempt += 1)); do
    http_status="$("$CURL_BIN" --silent --show-error --output "$health_file" --write-out '%{http_code}' --max-time 2 "$HEALTH_URL" 2>/dev/null || true)"
    if [[ "$http_status" == "200" ]] && "$NODE_BIN" - "$health_file" >/dev/null 2>&1 <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (value.ok !== true) process.exit(1);
NODE
    then
      rm -f -- "$health_file"
      return 0
    fi
    sleep 1
done
  rm -f -- "$health_file"
  return 1
}

atomic_switch_to() {
  local target="$1"
  rm -f -- "$CURRENT_NEW_LINK"
  ln -s -- "$target" "$CURRENT_NEW_LINK"
  mv -Tf -- "$CURRENT_NEW_LINK" "$CURRENT_LINK"
}

rollback_update() {
  local rollback_failed=0
  phase="rollback"
  "$SYSTEMCTL_BIN" stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  rm -f -- "$CURRENT_NEW_LINK"
  if ! ln -s -- "$previous_target" "$CURRENT_NEW_LINK" || ! mv -Tf -- "$CURRENT_NEW_LINK" "$CURRENT_LINK"; then
    rollback_failed=1
  fi
  if [[ -n "${backup_path:-}" && -f "$backup_path" ]]; then
    if ! cp -- "$backup_path" "$DATABASE_FILE"; then
      rollback_failed=1
    else
      chown 9router:9router "$DATABASE_FILE" || rollback_failed=1
      chmod 0600 "$DATABASE_FILE" || rollback_failed=1
    fi
  fi
  if ! "$SYSTEMCTL_BIN" start "$SERVICE_NAME" >/dev/null 2>&1; then
    rollback_failed=1
  fi
  if [[ "$rollback_failed" -eq 1 ]]; then
    failure_code="rollback-failed"
  fi
  return "$rollback_failed"
}

retain_releases() {
  local release
  for release in "$RELEASES_DIR"/*; do
    [[ -d "$release" ]] || continue
    [[ "$release" == "$release_dir" ]] && continue
    [[ -n "${previous_target:-}" && "$release" == "$previous_target" ]] && continue
    rm -rf -- "$release"
done
}

install_release() {
  ensure_account_and_directories
  ensure_environment
  clone_and_build
  phase="service-install"
  [[ -f "$release_dir/deploy/systemd/9router.service" ]] || fail "service-unit-missing"
  install -o root -g root -m 0644 "$release_dir/deploy/systemd/9router.service" /etc/systemd/system/9router.service
  "$SYSTEMCTL_BIN" daemon-reload || fail "daemon-reload-failed"
  atomic_switch_to "$release_dir" || fail "current-switch-failed"
  candidate_cleanup=0
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
  mkdir "$LOCK_DIR" || fail "deployment-in-progress"
  lock_held=1
  previous_target="$(resolve_current_target)"
  previous_tag="$(basename -- "$previous_target")"
  [[ "$previous_tag" =~ $TAG_PATTERN ]] || fail "current-release-invalid"
  current_tag="$previous_tag"
  clone_and_build
  phase="stop-service"
  "$SYSTEMCTL_BIN" stop "$SERVICE_NAME" || fail "service-stop-failed"
  phase="backup"
  backup_path="$BACKUP_DIR/$(date -u +%Y%m%dT%H%M%SZ)-${tag}.sqlite"
  if [[ -f "$DATABASE_FILE" ]]; then
    cp -- "$DATABASE_FILE" "$backup_path" || fail "database-backup-failed"
    chown 9router:9router "$backup_path"
    chmod 0600 "$backup_path"
  else
    backup_path=""
  fi
  phase="switch"
  atomic_switch_to "$release_dir" || fail "current-switch-failed"
  candidate_cleanup=0
  current_tag="$tag"
  phase="health-check"
  if ! "$SYSTEMCTL_BIN" start "$SERVICE_NAME" || ! health_check; then
    failure_code="health-check-failed"
    rollback_update || true
    fail "$failure_code"
  fi
  phase="retention"
  retain_releases
  phase="complete"
  write_status true ""
}

if [[ "$operation" == "install" ]]; then
  install_release
else
  update_release
fi

exit 0
