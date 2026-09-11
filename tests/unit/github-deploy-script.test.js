import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = path.resolve(process.cwd(), "../deploy/github-deploy.sh");

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
});
