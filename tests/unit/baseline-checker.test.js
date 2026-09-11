import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const testsDir = path.resolve(new URL("..", import.meta.url).pathname);
const checker = path.join(testsDir, "__baseline__/verify-no-regression.mjs");

describe("baseline regression checker", () => {
  it("normalizes local absolute Vitest paths to known-fail paths", () => {
    const resultPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "9router-baseline-")),
      "results.json"
    );
    fs.writeFileSync(resultPath, JSON.stringify({
      testResults: [{
        name: path.join(testsDir, "unit/rtk.test.js"),
        assertionResults: [{
          status: "failed",
          fullName: "RTK flag default off, toggle works",
        }],
      }],
    }));

    const result = spawnSync(process.execPath, [checker, resultPath], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No regression");
    fs.rmSync(path.dirname(resultPath), { recursive: true, force: true });
  });
});
