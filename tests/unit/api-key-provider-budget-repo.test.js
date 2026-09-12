import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ db: null }));

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => state.db),
}));

import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";
import { TABLES, buildCreateTableSql } from "../../src/lib/db/schema.js";
import {
  getApiKeyProviderBudgets,
  replaceApiKeyProviderBudgets,
  upsertApiKeyProviderUsage,
  resetApiKeyProviderUsage,
  deleteApiKeyProviderData,
} from "../../src/lib/db/repos/apiKeyProviderBudgetRepo.js";
import {
  resetApiKeyUsageById,
} from "../../src/lib/db/repos/apiKeyUsageRepo.js";
import { deleteApiKey } from "../../src/lib/db/repos/apiKeysRepo.js";

let tempDbPath;

async function makeDb() {
  tempDbPath = path.join(os.tmpdir(), `9router-provider-budget-${process.pid}-${Date.now()}.sqlite`);
  const db = await createSqlJsAdapter(tempDbPath);
  for (const tableName of ["apiKeys", "apiKeyUsage", "apiKeyProviderBudget", "apiKeyProviderUsage"]) {
    const table = TABLES[tableName];
    db.exec(buildCreateTableSql(tableName, table));
    for (const index of table.indexes || []) db.exec(index);
  }
  return db;
}

beforeEach(async () => {
  state.db = await makeDb();
});

afterEach(() => {
  state.db?.close();
  state.db = null;
  if (tempDbPath) {
    try { fs.unlinkSync(tempDbPath); } catch {}
    tempDbPath = null;
  }
});

describe("API key provider budgets", () => {
  it("replaces policies and returns the policy/current-usage union", async () => {
    await replaceApiKeyProviderBudgets("key-1", [
      { provider: "openai", inputTokensMonthly: 100, outputTokensMonthly: null, creditsMonthly: null },
      { provider: "kiro", inputTokensMonthly: null, outputTokensMonthly: 200, creditsMonthly: 3.5 },
    ]);
    upsertApiKeyProviderUsage(state.db, {
      apiKeyId: "key-1", provider: "openai", periodKey: "2026-09", inputTokens: 25, outputTokens: 4,
    });

    await expect(getApiKeyProviderBudgets("key-1", "2026-09")).resolves.toEqual([
      expect.objectContaining({
        provider: "kiro",
        inputTokensMonthly: null,
        outputTokensMonthly: 200,
        creditsMonthly: 3.5,
        usage: { periodKey: "2026-09", inputTokens: 0, outputTokens: 0, credits: 0 },
      }),
      expect.objectContaining({
        provider: "openai",
        inputTokensMonthly: 100,
        usage: { periodKey: "2026-09", inputTokens: 25, outputTokens: 4, credits: 0 },
      }),
    ]);
  });

  it("upserts additive provider usage and resets only the requested period", async () => {
    upsertApiKeyProviderUsage(state.db, {
      apiKeyId: "key-1", provider: "openai", periodKey: "2026-09", inputTokens: 10, outputTokens: 5,
    });
    upsertApiKeyProviderUsage(state.db, {
      apiKeyId: "key-1", provider: "openai", periodKey: "2026-09", inputTokens: 2, outputTokens: 1,
    });
    upsertApiKeyProviderUsage(state.db, {
      apiKeyId: "key-1", provider: "openai", periodKey: "2026-08", inputTokens: 9, outputTokens: 8,
    });

    expect(await resetApiKeyProviderUsage("key-1", "openai", "2026-09")).toBe(true);
    expect(state.db.get("SELECT * FROM apiKeyProviderUsage WHERE apiKeyId = ? AND provider = ? AND periodKey = ?", ["key-1", "openai", "2026-09"])).toBeUndefined();
    expect(state.db.get("SELECT inputTokens FROM apiKeyProviderUsage WHERE apiKeyId = ? AND provider = ? AND periodKey = ?", ["key-1", "openai", "2026-08"]).inputTokens).toBe(9);
  });

  it("resets only current global and provider usage for an existing key", async () => {
    state.db.run(
      `INSERT INTO apiKeys(id, key, createdAt) VALUES (?, ?, ?)`,
      ["key-1", "sk-key-1", new Date().toISOString()]
    );
    state.db.run(
      `INSERT INTO apiKeyUsage(apiKeyId, periodKey, inputTokens, outputTokens, credits) VALUES (?, ?, ?, ?, ?)`,
      ["key-1", "2026-09", 4, 5, 1]
    );
    state.db.run(
      `INSERT INTO apiKeyUsage(apiKeyId, periodKey, inputTokens, outputTokens, credits) VALUES (?, ?, ?, ?, ?)`,
      ["key-1", "2026-08", 8, 9, 2]
    );
    upsertApiKeyProviderUsage(state.db, {
      apiKeyId: "key-1", provider: "openai", periodKey: "2026-09", inputTokens: 4, outputTokens: 5,
    });
    upsertApiKeyProviderUsage(state.db, {
      apiKeyId: "key-1", provider: "openai", periodKey: "2026-08", inputTokens: 8, outputTokens: 9,
    });

    await expect(resetApiKeyUsageById("key-1", "2026-09")).resolves.toBe(true);
    expect(state.db.get("SELECT * FROM apiKeyUsage WHERE apiKeyId = ? AND periodKey = ?", ["key-1", "2026-09"])).toBeUndefined();
    expect(state.db.get("SELECT inputTokens FROM apiKeyUsage WHERE apiKeyId = ? AND periodKey = ?", ["key-1", "2026-08"]).inputTokens).toBe(8);
    expect(state.db.get("SELECT * FROM apiKeyProviderUsage WHERE apiKeyId = ? AND periodKey = ?", ["key-1", "2026-09"])).toBeUndefined();
    expect(state.db.get("SELECT inputTokens FROM apiKeyProviderUsage WHERE apiKeyId = ? AND periodKey = ?", ["key-1", "2026-08"]).inputTokens).toBe(8);
  });

  it("deletes global and provider rows with the key while history remains", async () => {
    state.db.run(
      `INSERT INTO apiKeys(id, key, createdAt) VALUES (?, ?, ?)`,
      ["key-1", "sk-key-1", new Date().toISOString()]
    );
    state.db.run(
      `INSERT INTO apiKeyUsage(apiKeyId, periodKey, inputTokens) VALUES (?, ?, ?)`,
      ["key-1", "2026-09", 8]
    );
    await replaceApiKeyProviderBudgets("key-1", [{ provider: "openai", inputTokensMonthly: 1 }]);
    upsertApiKeyProviderUsage(state.db, { apiKeyId: "key-1", provider: "openai", periodKey: "2026-09", inputTokens: 1 });
    state.db.run(
      `CREATE TABLE IF NOT EXISTS usageHistory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        apiKey TEXT,
        promptTokens INTEGER DEFAULT 0,
        completionTokens INTEGER DEFAULT 0
      )`
    );
    state.db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, apiKey) VALUES (?, ?, ?, ?)`,
      [new Date().toISOString(), "openai", "gpt-test", "sk-key-1"]
    );

    expect(await deleteApiKey("key-1")).toBe(true);
    expect(state.db.get("SELECT * FROM apiKeys WHERE id = ?", ["key-1"])).toBeUndefined();
    expect(state.db.get("SELECT * FROM apiKeyUsage WHERE apiKeyId = ?", ["key-1"])).toBeUndefined();
    expect(state.db.get("SELECT * FROM apiKeyProviderBudget WHERE apiKeyId = ?", ["key-1"])).toBeUndefined();
    expect(state.db.get("SELECT * FROM apiKeyProviderUsage WHERE apiKeyId = ?", ["key-1"])).toBeUndefined();
    expect(state.db.get("SELECT * FROM usageHistory WHERE apiKey = ?", ["sk-key-1"])).toBeDefined();
  });
});
