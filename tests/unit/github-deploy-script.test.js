import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = path.resolve(process.cwd(), "../deploy/github-deploy.sh");
const scriptSource = readFileSync(script, "utf8");

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
    expect(scriptSource).toContain("+%s%3N");
    expect(scriptSource).toContain('--max-time "$curl_timeout"');
  });
});
