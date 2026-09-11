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
});
