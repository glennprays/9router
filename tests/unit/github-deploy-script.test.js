import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = path.resolve(process.cwd(), "../deploy/github-deploy.sh");
const scriptSource = readFileSync(script, "utf8");
const runbookSource = readFileSync(
  path.resolve(process.cwd(), "../docs/GITHUB-SOURCE-VPS.md"),
  "utf8",
);
describe("GitHub deployment script arguments", () => {
  it("prints help without requiring root", async () => {
    const { stdout } = await run("bash", [script, "--help"]);
    expect(stdout).toContain("install --tag");
    expect(stdout).toContain("update --tag");
  });

  it("rejects branch names and path traversal", async () => {
    await expect(run("bash", [script, "update", "--tag", "master"]))
      .rejects.toMatchObject({ code: 2 });
    await expect(run("bash", [script, "update", "--tag", "v../current"]))
      .rejects.toMatchObject({ code: 2 });
  });
  it("accepts a valid tag before applying the non-root guard", async () => {
    await expect(run("bash", [script, "update", "--tag", "v0.5.70"]))
      .rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining("require root"),
      });
  });
  it("rejects deployment path overrides before the root guard", async () => {
    for (const variable of ["UPDATE_ROOT", "DATA_DIR", "ENV_FILE"]) {
      await expect(run("bash", [script, "update", "--tag", "v0.5.70"], {
        env: { ...process.env, [variable]: "/tmp/override" },
      })).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining("path overrides"),
      });
    }
  });
  it("rejects a non-GitHub repository override before the root guard", async () => {
    await expect(run("bash", [script, "update", "--tag", "v0.5.70"], {
      env: { ...process.env, NINEROUTER_REPOSITORY_URL: "https://example.com/router.git" },
    })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("GitHub .git URL"),
    });
  });

  it("fails closed for an installed unit and systemd query errors", () => {
    expect(scriptSource).toContain(
      '[[ ! -e "$SERVICE_UNIT_PATH" && ! -L "$SERVICE_UNIT_PATH" ]]',
    );
    expect(scriptSource).toContain(
      '"$SYSTEMCTL_BIN" show "$SERVICE_NAME" --property=LoadState --value',
    );
    expect(scriptSource).toMatch(/case "\$load_state"[\s\S]*not-found/);
    expect(scriptSource).not.toContain('"$SYSTEMCTL_BIN" is-active');
    expect(scriptSource).not.toContain('"$SYSTEMCTL_BIN" is-enabled');
    expect(scriptSource).toContain('fail "service-query-failed"');
  });
  it("keeps post-switch rollback armed and bounds the build environment", () => {
    const updateStart = scriptSource.indexOf("update_release() {");
    const updateSource = scriptSource.slice(updateStart);
    const retention = updateSource.indexOf('phase="retention"');
    const successStatus = updateSource.indexOf('write_status true ""', retention);
    const transactionClear = updateSource.indexOf("transaction_active=0", successStatus);

    expect(updateStart).toBeGreaterThanOrEqual(0);
    expect(retention).toBeGreaterThanOrEqual(0);
    expect(successStatus).toBeGreaterThan(retention);
    expect(transactionClear).toBeGreaterThan(successStatus);
    expect(scriptSource).toContain('"$ENV_BIN" -i');
    expect(scriptSource).toContain('"HOME=$NPM_HOME"');
    expect(scriptSource).toContain('"npm_config_cache=$NPM_CACHE"');
    expect(scriptSource).toContain('"PATH=/usr/bin:/bin"');
    expect(scriptSource).toContain("monotonic_milliseconds()");
    expect(scriptSource).toContain("readonly HEALTH_TIMEOUT_MS=30000");
    expect(scriptSource).not.toContain("SECONDS");
    expect(scriptSource).toContain("if (( remaining_ms < 1000 ));");
  });
  it("guards rollback data and preserves stable/failed release artifacts", () => {
    const installStart = scriptSource.indexOf("install_release() {");
    const setup = scriptSource.indexOf("ensure_account_and_directories", installStart);
    const environment = scriptSource.indexOf("ensure_environment", setup);
    const databaseCapture = scriptSource.indexOf("capture_database_state", environment);
    expect(setup).toBeGreaterThan(installStart);
    expect(environment).toBeGreaterThan(setup);
    expect(databaseCapture).toBeGreaterThan(environment);
    const rollbackStart = scriptSource.indexOf("rollback_update() {");
    const rollbackStop = scriptSource.indexOf("stop_service_confirmed", rollbackStart);
    const rollbackDatabase = scriptSource.indexOf("restore_database", rollbackStart);
    expect(rollbackStop).toBeGreaterThan(rollbackStart);
    expect(rollbackDatabase).toBeGreaterThan(rollbackStop);
    expect(scriptSource).toContain('if stop_service_confirmed && [[ "$stop_confirmation_failed" -eq 0 ]]');
    expect(scriptSource).toContain('if [[ "$stop_ok" -eq 1 && "$stop_confirmed" -eq 1 && "$stop_confirmation_failed" -eq 0');
    expect(scriptSource).toContain('final_release="$RELEASES_DIR/$tag"');
    expect(scriptSource).toContain('[[ "$name" == *.failed-* ]] && continue');
    expect(scriptSource).toContain('failed_target="$RELEASES_DIR/${tag}.failed-');
    expect(scriptSource).toContain('stop_ok=1');
    expect(scriptSource).toContain("remove_installed_unit");
    expect(scriptSource).toContain('"$CMP_BIN"');
    expect(scriptSource).toContain("--user-group");
    expect(scriptSource).toContain('"$CHOWN_BIN" root:root "$DEPLOY_ROOT"');
    expect(scriptSource).toContain('"$CHOWN_BIN" 9router:9router "$DATABASE_DIR"');
    expect(scriptSource).toContain('"$CHMOD_BIN" 0770 "$DATABASE_DIR"');
    expect(scriptSource).toContain('"$CHMOD_BIN" 0700 "$RUNTIME_DIR" "$BACKUP_DIR"');
    expect(scriptSource).toContain('expected_service_unit > "$expected"');
    expect(scriptSource).toContain('"$INSTALL_BIN" -o root -g root -m 0644 "$expected"');
    expect(scriptSource).toContain("retain_backups");
    expect((runbookSource.match(/health_json=/g) || [])).toHaveLength(3);
    expect((runbookSource.match(/\/usr\/bin\/node -e/g) || [])).toHaveLength(3);
    expect(runbookSource).toContain("value.ok === true");
    expect(runbookSource).toContain("/opt/9router/releases/${GOOD_TAG}");
  });
  it("restores current safely and gates first-install cleanup on stop", () => {
    const updateRollbackStart = scriptSource.indexOf("rollback_update() {");
    const updateRollback = scriptSource.slice(updateRollbackStart, scriptSource.indexOf("rollback_first_install()", updateRollbackStart));
    const firstRollbackStart = scriptSource.indexOf("rollback_first_install() {");
    const firstRollback = scriptSource.slice(firstRollbackStart, scriptSource.indexOf("\n\non_exit()", firstRollbackStart));

    expect(updateRollback).not.toContain('safe_remove_symlink "$CURRENT_LINK"');
    expect(updateRollback).toContain('"$LN_BIN" -s -- "$previous_target" "$CURRENT_NEW_LINK"');
    expect(updateRollback).toContain('"$MV_BIN" -Tf -- "$CURRENT_NEW_LINK" "$CURRENT_LINK"');
    expect(updateRollback).toContain('"$DIRNAME_BIN" "$previous_target"');
    expect(scriptSource).toContain('LC_ALL=C "$STAT_BIN" -c');
    expect(runbookSource).toContain('test "$health_ok" -eq 1\n```\n\nThe health response');
    expect(runbookSource).toContain('test "$health_ok" -eq 1\n```\n\nIf the release changed');
    expect(updateRollback).toContain('if [[ "$stop_ok" -eq 1 && "$database_state_known" -eq 1 ]]');
    expect(firstRollback).toMatch(/if \[\[ "\$stop_ok" -eq 1 \]\]; then[\s\S]*remove_installed_unit/);
    expect(firstRollback).toMatch(/if \[\[ "\$stop_ok" -eq 1 \]\]; then[\s\S]*safe_remove_symlink "\$CURRENT_LINK"/);
  });
  it("guards rollback failure and preserves EXIT cleanup", () => {
    const exitStart = scriptSource.indexOf("on_exit() {");
    const exitTrap = scriptSource.slice(exitStart, scriptSource.indexOf("\ntrap on_exit EXIT", exitStart));
    const rollbackCall = exitTrap.indexOf('"$rollback_fn" || rollback_result=$?');

    expect(exitStart).toBeGreaterThanOrEqual(0);
    expect(exitTrap).toContain("rollback_result=0");
    expect(rollbackCall).toBeGreaterThanOrEqual(0);
    expect(exitTrap.indexOf('failure_code="$original_failure"', rollbackCall)).toBeGreaterThan(rollbackCall);
    expect(exitTrap.indexOf("preserve_failed_release", rollbackCall)).toBeGreaterThan(rollbackCall);
    expect(exitTrap.indexOf("write_failure_log", rollbackCall)).toBeGreaterThan(rollbackCall);
    expect(exitTrap.indexOf("release_lock")).toBeGreaterThan(exitTrap.indexOf("write_failure_log", rollbackCall));
  });
  it("verifies tags as the checkout owner and fails switch and resolution closed", () => {
    expect(scriptSource).toContain('"$RUNUSER_BIN" -u 9router -- "$GIT_BIN" -C "$candidate_dir" rev-parse HEAD');
    expect(scriptSource).toContain('"$RUNUSER_BIN" -u 9router -- "$GIT_BIN" -C "$candidate_dir" rev-parse "refs/tags/$tag^{commit}"');
    expect(scriptSource).not.toMatch(/head_commit="\$\(\$?GIT_BIN/);
    expect(scriptSource).toContain('[[ "$head_commit" == "$tag_commit" ]] || fail "clone-failed"');

    const switchStart = scriptSource.indexOf("atomic_switch_to() {");
    const switchSource = scriptSource.slice(switchStart, scriptSource.indexOf("retain_releases()", switchStart));
    expect(switchSource).toContain('"$LN_BIN" -s -- "$target" "$CURRENT_NEW_LINK" || return 1');
    expect(switchSource).toContain('"$MV_BIN" -Tf -- "$CURRENT_NEW_LINK" "$CURRENT_LINK" || return 1');
    expect(switchSource.indexOf("current_switched=1")).toBeGreaterThan(switchSource.indexOf('"$MV_BIN" -Tf'));

    const stopStart = scriptSource.indexOf("stop_service_confirmed() {");
    const stopSource = scriptSource.slice(stopStart, scriptSource.indexOf("safe_remove_symlink()", stopStart));
    expect(stopSource.indexOf("stop_confirmation_failed=0")).toBeGreaterThan(-1);
    expect(stopSource.indexOf("stop_confirmation_failed=0")).toBeLessThan(stopSource.indexOf('"$SYSTEMCTL_BIN" stop'));

    expect(scriptSource).toContain('failure_code="current-release-missing"; return 1');
    expect(scriptSource).toContain('failure_code="current-release-invalid"; return 1');
    expect(scriptSource).not.toContain('fail "current-release-missing"');
    expect(scriptSource).toContain('resolve_current_target || fail "$failure_code"');
    expect(scriptSource).toContain('resolve_current_tag "$previous_target" || fail "$failure_code"');
    expect(scriptSource).not.toContain('previous_target="$(resolve_current_target)"');
  });
});
