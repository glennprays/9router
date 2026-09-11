import { describe, expect, it, vi } from "vitest";
import {
  getUpdateSource,
  isExternalUpdateSource,
  buildExternalVersionResponse,
} from "@/lib/updater/updateMode.js";
import { buildVersionResponse, GET as getVersion } from "@/app/api/version/route.js";
import { startUpdateForMode } from "@/app/api/version/update/route.js";
import { shutdownForMode } from "@/app/api/version/shutdown/route.js";

describe("external update mode", () => {
  it("keeps npm mode as the default", () => {
    expect(getUpdateSource({})).toBe("npm");
    expect(getUpdateSource({ UPDATE_SOURCE: "" })).toBe("npm");
    expect(isExternalUpdateSource({})).toBe(false);
  });

  it("selects external mode without changing the executable", () => {
    expect(getUpdateSource({ UPDATE_SOURCE: "external" })).toBe("external");
    expect(buildExternalVersionResponse("0.5.69")).toEqual({
      updateSource: "external",
      currentVersion: "0.5.69",
      latestVersion: null,
      hasUpdate: false,
      managedExternally: true,
    });
  });

  it("fails closed for an unknown source", () => {
    expect(getUpdateSource({ UPDATE_SOURCE: "github" })).toBe("invalid");
  });

  it("does not query npm in external mode", async () => {
    const fetchLatest = vi.fn(async () => "0.5.70");
    await expect(buildVersionResponse({
      env: { UPDATE_SOURCE: "external" },
      packageVersion: "0.5.69",
      fetchLatest,
    })).resolves.toMatchObject({ updateSource: "external", hasUpdate: false });
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it("returns externally managed state from the version route", async () => {
    vi.stubEnv("UPDATE_SOURCE", "external");
    try {
      const response = await getVersion();
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        updateSource: "external",
        currentVersion: "0.5.69",
        latestVersion: null,
        hasUpdate: false,
        managedExternally: true,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });


  it("preserves npm version lookup and comparison", async () => {
    const fetchLatest = vi.fn(async () => "0.5.70");
    await expect(buildVersionResponse({
      env: { UPDATE_SOURCE: "npm" },
      packageVersion: "0.5.69",
      fetchLatest,
    })).resolves.toEqual({
      currentVersion: "0.5.69",
      latestVersion: "0.5.70",
      hasUpdate: true,
    });
    expect(fetchLatest).toHaveBeenCalledOnce();
  });

  it("runs the npm updater callback in npm mode", async () => {
    const startNpmUpdate = vi.fn(async () => new Response(null, { status: 202 }));
    const response = await startUpdateForMode({
      env: { UPDATE_SOURCE: "npm" },
      startNpmUpdate,
    });
    expect(response.status).toBe(202);
    expect(startNpmUpdate).toHaveBeenCalledOnce();
  });

  it("kills application processes in npm shutdown mode", async () => {
    const killAppProcesses = vi.fn();
    const response = await shutdownForMode({
      env: { UPDATE_SOURCE: "npm" },
      killAppProcesses,
    });
    expect(response).toBeNull();
    expect(killAppProcesses).toHaveBeenCalledOnce();
  });

  it("rejects invalid mode for every route", async () => {
    const fetchLatest = vi.fn(async () => "0.5.70");
    await expect(buildVersionResponse({
      env: { UPDATE_SOURCE: "github" },
      packageVersion: "0.5.69",
      fetchLatest,
    })).resolves.toMatchObject({ updateSource: "invalid" });
    expect(fetchLatest).not.toHaveBeenCalled();

    vi.stubEnv("UPDATE_SOURCE", "github");
    try {
      expect((await getVersion()).status).toBe(500);
    } finally {
      vi.unstubAllEnvs();
    }

    const startNpmUpdate = vi.fn();
    const updateResponse = await startUpdateForMode({
      env: { UPDATE_SOURCE: "github" },
      startNpmUpdate,
    });
    expect(updateResponse.status).toBe(500);
    expect(startNpmUpdate).not.toHaveBeenCalled();

    const killAppProcesses = vi.fn();
    const shutdownResponse = await shutdownForMode({
      env: { UPDATE_SOURCE: "github" },
      killAppProcesses,
    });
    expect(shutdownResponse.status).toBe(500);
    expect(killAppProcesses).not.toHaveBeenCalled();
  });
  it("rejects application update requests in external mode", async () => {
    const startNpmUpdate = vi.fn();
    const response = await startUpdateForMode({
      env: { NODE_ENV: "production", UPDATE_SOURCE: "external" },
      startNpmUpdate,
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.message).toContain("tag-pinned deployment script");
    expect(body.message).toContain("deploy/github-deploy.sh");
    expect(body.message).toContain("update --tag");
    expect(startNpmUpdate).not.toHaveBeenCalled();
  });

  it("does not kill a systemd-managed process for dashboard shutdown", async () => {
    const killAppProcesses = vi.fn();
    const response = await shutdownForMode({
      env: { UPDATE_SOURCE: "external" },
      killAppProcesses,
    });
    expect(response.status).toBe(409);
    expect(killAppProcesses).not.toHaveBeenCalled();
  });
});
