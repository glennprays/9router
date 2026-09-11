import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const state = vi.hoisted(() => ({
  db: null,
  policy: null,
  usage: { inputTokens: 0, outputTokens: 0, credits: 0 },
  teamPolicy: null,
  teamUsage: { inputTokens: 0, outputTokens: 0, credits: 0 },
  accountBudgets: new Map(),
  accountUsage: new Map(),
  connections: [],
  rate: 0,
  saveRequestUsage: vi.fn(),
}));

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => state.db),
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeyPolicyByKey: vi.fn(async () => state.policy),
  getApiKeyUsage: vi.fn(async () => ({ key: "k1", periodKey: "2026-09", ...state.usage })),
  getKiroCreditRate: vi.fn(async () => state.rate),
  getTeamBudgetPolicy: vi.fn(async () => state.teamPolicy),
  getTeamUsage: vi.fn(async () => ({ periodKey: "2026-09", ...state.teamUsage })),
  getKiroAccountBudgets: vi.fn(async () => state.accountBudgets),
  getAllKiroAccountUsage: vi.fn(async () => state.accountUsage),
  getProviderConnections: vi.fn(async () => state.connections),
  monthKey: vi.fn(() => "2026-09"),
}));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: state.saveRequestUsage,
}));

import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";
import { TABLES, buildCreateTableSql } from "../../src/lib/db/schema.js";
import {
  getApiKeyUsage,
  monthKey,
  upsertApiKeyUsage,
} from "../../src/lib/db/repos/apiKeyUsageRepo.js";
import { getKiroAccountUsage } from "../../src/lib/db/repos/kiroAccountBudgetRepo.js";
import { getTeamUsage } from "../../src/lib/db/repos/teamBudgetRepo.js";
import { saveRequestUsage } from "../../src/lib/db/repos/usageRepo.js";
import { extractUsage, hasValidUsage } from "../../open-sse/utils/usageTracking.js";
import {
  clampOutputTokens,
  resolveAccountOutputCap,
  resolveBudgetContext,
} from "../../src/sse/limits/kiroBudget.js";
import { saveUsageStats } from "../../open-sse/handlers/chatCore/requestDetail.js";

let tempDbPath;

async function makeDb(tableNames) {
  tempDbPath = path.join(os.tmpdir(), `9router-api-key-limiter-${process.pid}-${Date.now()}.sqlite`);
  const db = await createSqlJsAdapter(tempDbPath);
  for (const tableName of tableNames) {
    const table = TABLES[tableName];
    db.exec(buildCreateTableSql(tableName, table));
    for (const index of table.indexes || []) db.exec(index);
  }
  return db;
}

beforeEach(() => {
  state.policy = null;
  state.usage = { inputTokens: 0, outputTokens: 0, credits: 0 };
  state.teamPolicy = null;
  state.teamUsage = { inputTokens: 0, outputTokens: 0, credits: 0 };
  state.accountBudgets = new Map();
  state.accountUsage = new Map();
  state.connections = [];
  state.rate = 0;
  state.saveRequestUsage.mockReset();
  state.saveRequestUsage.mockResolvedValue(undefined);
});

afterEach(() => {
  if (state.db) {
    state.db.close();
    state.db = null;
  }
  if (tempDbPath) {
    try { fs.unlinkSync(tempDbPath); } catch {}
    tempDbPath = null;
  }
});

describe("API key usage persistence", () => {
  it("uses the local calendar month", () => {
    expect(monthKey("2026-09-10T15:00:00Z")).toBe("2026-09");
    const now = new Date();
    expect(monthKey()).toBe(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  });

  it("upserts counters and keeps periods separate", async () => {
    state.db = await makeDb(["apiKeyUsage"]);

    upsertApiKeyUsage(state.db, {
      key: "k1", periodKey: "2026-09", inputTokens: 100, outputTokens: 50, credits: 0.5,
    });
    upsertApiKeyUsage(state.db, {
      key: "k1", periodKey: "2026-09", inputTokens: 100, outputTokens: 50, credits: 0.5,
    });
    upsertApiKeyUsage(state.db, {
      key: "k1", periodKey: "2026-10", inputTokens: 7, outputTokens: 8, credits: 0.25,
    });

    await expect(getApiKeyUsage("k1", "2026-09")).resolves.toEqual({
      key: "k1", periodKey: "2026-09", inputTokens: 200, outputTokens: 100, credits: 1,
    });
    await expect(getApiKeyUsage("k1", "2026-10")).resolves.toEqual({
      key: "k1", periodKey: "2026-10", inputTokens: 7, outputTokens: 8, credits: 0.25,
    });
  });
});

describe("API key budget admission", () => {
  it.each([
    { provider: "openai", apiKey: "k1" },
    { provider: "kiro", apiKey: null },
  ])("does not enforce $provider with apiKey=$apiKey", async ({ provider, apiKey }) => {
    state.policy = {
      inputTokensMonthly: 100,
      outputTokensMonthly: 100,
      creditsMonthly: 1,
    };
    await expect(resolveBudgetContext({
      apiKey, provider, model: "claude-haiku", body: { messages: [{ role: "user", content: "hi" }] },
    })).resolves.toBeNull();
  });

  it("does not enforce a key with no limits", async () => {
    state.policy = {
      inputTokensMonthly: null,
      outputTokensMonthly: null,
      creditsMonthly: null,
    };
    await expect(resolveBudgetContext({
      apiKey: "k1", provider: "kiro", model: "claude-haiku", body: { messages: [] },
    })).resolves.toBeNull();
  });

  it("rejects a key whose input budget is exhausted", async () => {
    state.policy = {
      inputTokensMonthly: 100,
      outputTokensMonthly: 100,
      creditsMonthly: 1,
    };
    state.usage = { inputTokens: 100, outputTokens: 0, credits: 0 };

    const result = await resolveBudgetContext({
      apiKey: "k1", provider: "kiro", model: "claude-haiku", body: { messages: [] },
    });

    expect(result.reject).toBeInstanceOf(Response);
    expect(result.reject.status).toBe(429);
    await expect(result.reject.json()).resolves.toMatchObject({
      error: { type: "insufficient_quota", code: "insufficient_quota" },
    });
  });

  it("rejects malformed stored limits instead of treating them as unlimited", async () => {
    state.policy = {
      inputTokensMonthly: "not-a-number",
      outputTokensMonthly: null,
      creditsMonthly: null,
    };
    const result = await resolveBudgetContext({
      apiKey: "k1", provider: "kiro", model: "claude-haiku", body: { messages: [] },
    });
    expect(result.reject).toBeInstanceOf(Response);
    expect(result.reject.status).toBe(429);
  });
  it("rejects malformed stored account limits instead of treating them as unlimited", async () => {
    state.accountBudgets = new Map([["connA", "not-a-number"]]);
    state.connections = [{ id: "connA" }];

    const result = await resolveBudgetContext({
      apiKey: null, provider: "kiro", model: "claude-haiku", body: { messages: [] },
    });

    expect(result.reject).toBeInstanceOf(Response);
    expect(result.reject.status).toBe(429);
    await expect(result.reject.json()).resolves.toMatchObject({
      error: { message: "Invalid budget configuration" },
    });
  });

  it("uses the known rate to tighten output for account-only ceilings", async () => {
    state.accountBudgets = new Map([["connA", 2000]]);
    state.accountUsage = new Map([["connA", 1900]]);
    state.connections = [{ id: "connA" }];
    state.rate = 5;

    const result = await resolveBudgetContext({
      apiKey: null, provider: "kiro", model: "claude-haiku", body: { messages: [] },
    });

    expect(result).toMatchObject({ reject: null, outputCap: null, rate: 5 });

    expect(resolveAccountOutputCap(result, "connA")).toEqual({
      skip: false,
      cap: Math.floor(100 / 5) - result.inputEstimate,
    });
  });

  it("blocks when the team credit budget is exhausted", async () => {
    state.teamPolicy = { inputTokensMonthly: null, outputTokensMonthly: null, creditsMonthly: 10 };
    state.teamUsage = { inputTokens: 0, outputTokens: 0, credits: 10 };

    const result = await resolveBudgetContext({
      apiKey: null, provider: "kiro", model: "claude-haiku", body: { messages: [] },
    });

    expect(result.reject).toBeInstanceOf(Response);
    expect(result.reject.status).toBe(429);
  });

  it("intersects member and team output allowances", async () => {
    state.policy = { inputTokensMonthly: null, outputTokensMonthly: 100, creditsMonthly: null };
    state.usage = { inputTokens: 0, outputTokens: 0, credits: 0 };
    state.teamPolicy = { inputTokensMonthly: null, outputTokensMonthly: 40, creditsMonthly: null };
    state.teamUsage = { inputTokens: 0, outputTokens: 0, credits: 0 };

    const result = await resolveBudgetContext({
      apiKey: "k1", provider: "kiro", model: "claude-haiku", body: { messages: [] },
    });

    expect(result).toMatchObject({ reject: null, outputCap: 40 });
  });

  it("excludes exhausted accounts while retaining an unlimited account", async () => {
    state.accountBudgets = new Map([["connA", 2000]]);
    state.accountUsage = new Map([["connA", 2000]]);
    state.connections = [{ id: "connA" }, { id: "connB" }];

    const result = await resolveBudgetContext({
      apiKey: null, provider: "kiro", model: "claude-haiku", body: { messages: [] },
    });

    expect(result).toMatchObject({ reject: null, excludeConnectionIds: ["connA"] });
    expect(result.accountRemaining).toEqual(new Map());
  });

  it("rejects when every active account is exhausted", async () => {
    state.accountBudgets = new Map([["connA", 2000]]);
    state.accountUsage = new Map([["connA", 2000]]);
    state.connections = [{ id: "connA" }];

    const result = await resolveBudgetContext({
      apiKey: null, provider: "kiro", model: "claude-haiku", body: { messages: [] },
    });

    expect(result.reject).toBeInstanceOf(Response);
    expect(result.reject.status).toBe(429);
  });

  it("ignores budget rows for connections that are no longer active", async () => {
    // Orphaned by a deleted account (hand-edited backup) and by a paused account:
    // neither may force the slow path or fail-close the pool.
    state.accountBudgets = new Map([["deleted", "not-a-number"], ["paused", 500]]);
    state.connections = [{ id: "connA" }];

    await expect(resolveBudgetContext({
      apiKey: null, provider: "kiro", model: "claude-haiku", body: { messages: [] },
    })).resolves.toBeNull();
  });

  it("tightens or skips output for a selected account", () => {
    const budget = {
      outputCap: 40,
      accountRemaining: new Map([["connA", 20]]),
      remainingCredits: 100,
      rate: 5,
      inputEstimate: 0,
    };
    expect(resolveAccountOutputCap(budget, "connA")).toEqual({ skip: false, cap: 4 });

    const tightBudget = {
      ...budget,
      accountRemaining: new Map([["connA", 1]]),
      remainingCredits: 5,
    };
    expect(resolveAccountOutputCap(tightBudget, "connA")).toEqual({ skip: true, cap: null });
  });

  it("clamps all request field shapes without mutating the body", () => {
    const body = {
      max_tokens: 100,
      max_completion_tokens: 80,
      max_output_tokens: 70,
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { maxOutputTokens: 90, temperature: 0.2 },
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 60 },
      },
    };
    const capped = clampOutputTokens(body, 50);

    expect(capped).toEqual({
      ...body,
      max_tokens: 50,
      max_completion_tokens: 50,
      max_output_tokens: 50,
      generationConfig: { maxOutputTokens: 50, temperature: 0.2 },
      request: {
        ...body.request,
        generationConfig: { maxOutputTokens: 50 },
      },
    });
    expect(capped).not.toBe(body);
    expect(capped.generationConfig).not.toBe(body.generationConfig);
    expect(capped.request).not.toBe(body.request);
    expect(body.max_tokens).toBe(100);
    expect(clampOutputTokens(body, null)).toBe(body);
  });
});

describe("Kiro credits plumbing", () => {
  it("passes raw Kiro credits and the client API key to saveRequestUsage", () => {
    saveUsageStats({
      provider: "kiro",
      model: "claude-haiku",
      apiKey: "k1",
      tokens: { prompt_tokens: 10, completion_tokens: 5, kiro_credits: 2 },
      silent: true,
    });

    expect(state.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "k1",
      credits: 2,
    }));
  });

  it("records credit-only usage instead of returning before persistence", () => {
    saveUsageStats({
      provider: "kiro",
      model: "claude-haiku",
      apiKey: "k1",
      tokens: { kiro_credits: 2 },
      silent: true,
    });

    expect(state.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "k1",
      credits: 2,
    }));
  });

  it("preserves Kiro credits when extracting streaming usage", () => {
    expect(extractUsage({
      usage: { prompt_tokens: 10, completion_tokens: 5, kiro_credits: 2 },
    })).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 5,
      kiro_credits: 2,
    });
  });
  it("treats credit-only usage as valid for stream finalization", () => {
    expect(hasValidUsage({ kiro_credits: 2 })).toBe(true);
  });

  it("accounts a completed request once across member, account, and team scopes", async () => {
    state.db = await makeDb(["_meta", "usageHistory", "usageDaily", "apiKeyUsage", "teamUsage", "kiroAccountUsage"]);
    const entry = {
      provider: "kiro",
      model: "claude-haiku",
      apiKey: "k1",
      connectionId: "connA",
      timestamp: "2026-09-10T12:00:00.000Z",
      tokens: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      credits: 2,
    };

    await saveRequestUsage({ ...entry, tokens: { ...entry.tokens } });
    await saveRequestUsage({ ...entry, tokens: { ...entry.tokens } });

    await expect(getApiKeyUsage("k1", "2026-09")).resolves.toEqual({
      key: "k1", periodKey: "2026-09", inputTokens: 10, outputTokens: 5, credits: 2,
    });
    await expect(getTeamUsage("2026-09")).resolves.toEqual({
      periodKey: "2026-09", inputTokens: 10, outputTokens: 5, credits: 2,
    });
    await expect(getKiroAccountUsage("connA", "2026-09")).resolves.toEqual({
      connectionId: "connA", periodKey: "2026-09", credits: 2,
    });
  });

  it("charges keyless Kiro requests to account and team scopes only", async () => {
    state.db = await makeDb(["_meta", "usageHistory", "usageDaily", "apiKeyUsage", "teamUsage", "kiroAccountUsage"]);
    await saveRequestUsage({
      provider: "kiro",
      model: "claude-haiku",
      connectionId: "connA",
      timestamp: "2026-09-10T12:01:00.000Z",
      tokens: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      credits: 2,
    });

    expect(state.db.get("SELECT * FROM apiKeyUsage")).toBeUndefined();
    await expect(getTeamUsage("2026-09")).resolves.toMatchObject({
      inputTokens: 10, outputTokens: 5, credits: 2,
    });
    await expect(getKiroAccountUsage("connA", "2026-09")).resolves.toMatchObject({
      credits: 2,
    });
  });

  it("charges Kiro requests without a connection to member and team scopes only", async () => {
    state.db = await makeDb(["_meta", "usageHistory", "usageDaily", "apiKeyUsage", "teamUsage", "kiroAccountUsage"]);
    await saveRequestUsage({
      provider: "kiro",
      model: "claude-haiku",
      apiKey: "k1",
      timestamp: "2026-09-10T12:02:00.000Z",
      tokens: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      credits: 2,
    });

    await expect(getApiKeyUsage("k1", "2026-09")).resolves.toMatchObject({
      inputTokens: 10, outputTokens: 5, credits: 2,
    });
    await expect(getTeamUsage("2026-09")).resolves.toMatchObject({
      inputTokens: 10, outputTokens: 5, credits: 2,
    });
    expect(state.db.get("SELECT * FROM kiroAccountUsage")).toBeUndefined();
  });

  it("does not charge any Kiro counters for non-Kiro requests", async () => {
    state.db = await makeDb(["_meta", "usageHistory", "usageDaily", "apiKeyUsage", "teamUsage", "kiroAccountUsage"]);
    await saveRequestUsage({
      provider: "openai",
      model: "gpt-test",
      apiKey: "k1",
      connectionId: "connA",
      timestamp: "2026-09-10T13:00:00.000Z",
      tokens: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      credits: 9,
    });

    expect(state.db.get("SELECT * FROM apiKeyUsage")).toBeUndefined();
    expect(state.db.get("SELECT * FROM teamUsage")).toBeUndefined();
    expect(state.db.get("SELECT * FROM kiroAccountUsage")).toBeUndefined();
  });


  it("keeps the dashboard API key modal state declaration in source", async () => {
    const source = await (await import("node:fs/promises")).readFile(
      new URL("../../src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js", import.meta.url),
      "utf8"
    );
    expect(source).toContain("const [showAddModal, setShowAddModal] = useState(false);");
  });
});
