import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const state = vi.hoisted(() => ({
  db: null,
  policy: null,
  usage: { inputTokens: 0, outputTokens: 0, credits: 0 },
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
import { saveRequestUsage } from "../../src/lib/db/repos/usageRepo.js";
import { resolveBudgetContext } from "../../src/sse/limits/apiKeyBudget.js";
import { saveUsageStats } from "../../open-sse/handlers/chatCore/requestDetail.js";
import { extractUsage, hasValidUsage } from "../../open-sse/utils/usageTracking.js";

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

  it("accounts a completed request once even when save is retried", async () => {
    state.db = await makeDb(["_meta", "usageHistory", "usageDaily", "apiKeyUsage"]);
    const entry = {
      provider: "kiro",
      model: "claude-haiku",
      apiKey: "k1",
      timestamp: "2026-09-10T12:00:00.000Z",
      tokens: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      credits: 2,
    };

    await saveRequestUsage({ ...entry, tokens: { ...entry.tokens } });
    await saveRequestUsage({ ...entry, tokens: { ...entry.tokens } });

    expect(state.db.get(
      "SELECT inputTokens, outputTokens, credits FROM apiKeyUsage WHERE key = ? AND periodKey = ?",
      ["k1", "2026-09"]
    )).toEqual({ inputTokens: 10, outputTokens: 5, credits: 2 });
  });

  it("does not charge Kiro counters for non-Kiro requests", async () => {
    state.db = await makeDb(["_meta", "usageHistory", "usageDaily", "apiKeyUsage"]);
    await saveRequestUsage({
      provider: "openai",
      model: "gpt-test",
      apiKey: "k1",
      timestamp: "2026-09-10T13:00:00.000Z",
      tokens: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      credits: 9,
    });

    expect(state.db.get("SELECT * FROM apiKeyUsage WHERE key = ?", ["k1"])).toBeUndefined();
  });

  it("keeps the dashboard API key modal state declaration in source", async () => {
    const source = await (await import("node:fs/promises")).readFile(
      new URL("../../src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js", import.meta.url),
      "utf8"
    );
    expect(source).toContain("const [showAddModal, setShowAddModal] = useState(false);");
  });
});
