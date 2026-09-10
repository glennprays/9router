import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const state = vi.hoisted(() => ({ db: null }));

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => state.db),
}));

import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";
import { TABLES, buildCreateTableSql } from "../../src/lib/db/schema.js";
import { monthKey } from "../../src/lib/db/repos/apiKeyUsageRepo.js";
import {
  getTeamBudgetPolicy,
  setTeamBudgetPolicy,
  getTeamUsage,
  upsertTeamUsage,
  resetTeamUsage,
} from "../../src/lib/db/repos/teamBudgetRepo.js";

let tempDbPath;

async function makeDb(tableNames) {
  tempDbPath = path.join(os.tmpdir(), `9router-team-budget-${process.pid}-${Date.now()}.sqlite`);
  const db = await createSqlJsAdapter(tempDbPath);
  for (const tableName of tableNames) {
    const table = TABLES[tableName];
    db.exec(buildCreateTableSql(tableName, table));
    for (const index of table.indexes || []) db.exec(index);
  }
  return db;
}

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

describe("team budget policy", () => {
  it("returns null when no policy has been set", async () => {
    state.db = await makeDb(["teamBudgetPolicy"]);
    await expect(getTeamBudgetPolicy()).resolves.toBeNull();
  });

  it("upserts the singleton row and preserves null as unlimited", async () => {
    state.db = await makeDb(["teamBudgetPolicy"]);

    await expect(setTeamBudgetPolicy({ creditsMonthly: 6000 })).resolves.toEqual({
      inputTokensMonthly: null, outputTokensMonthly: null, creditsMonthly: 6000,
    });
    await expect(getTeamBudgetPolicy()).resolves.toEqual({
      inputTokensMonthly: null, outputTokensMonthly: null, creditsMonthly: 6000,
    });

    // Second write replaces (not merges) and clears creditsMonthly back to unlimited.
    await expect(setTeamBudgetPolicy({
      inputTokensMonthly: 1000, outputTokensMonthly: 500, creditsMonthly: null,
    })).resolves.toEqual({ inputTokensMonthly: 1000, outputTokensMonthly: 500, creditsMonthly: null });
    await expect(getTeamBudgetPolicy()).resolves.toEqual({
      inputTokensMonthly: 1000, outputTokensMonthly: 500, creditsMonthly: null,
    });

    const { n } = state.db.get(`SELECT COUNT(*) AS n FROM teamBudgetPolicy`);
    expect(n).toBe(1);
    const { updatedAt } = state.db.get(`SELECT updatedAt FROM teamBudgetPolicy WHERE id = 1`);
    expect(typeof updatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(updatedAt))).toBe(false);
  });

  it("treats a missing argument as clearing every limit", async () => {
    state.db = await makeDb(["teamBudgetPolicy"]);
    await setTeamBudgetPolicy({ inputTokensMonthly: 10, outputTokensMonthly: 20, creditsMonthly: 30 });
    await expect(setTeamBudgetPolicy()).resolves.toEqual({
      inputTokensMonthly: null, outputTokensMonthly: null, creditsMonthly: null,
    });
    await expect(getTeamBudgetPolicy()).resolves.toEqual({
      inputTokensMonthly: null, outputTokensMonthly: null, creditsMonthly: null,
    });
  });
});

describe("team usage", () => {
  it("returns zero counters for an unknown period and defaults to the current month", async () => {
    state.db = await makeDb(["teamUsage"]);
    await expect(getTeamUsage("2026-09")).resolves.toEqual({
      periodKey: "2026-09", inputTokens: 0, outputTokens: 0, credits: 0,
    });
    await expect(getTeamUsage()).resolves.toEqual({
      periodKey: monthKey(), inputTokens: 0, outputTokens: 0, credits: 0,
    });
  });

  it("upserts additively and keeps periods separate", async () => {
    state.db = await makeDb(["teamUsage"]);

    upsertTeamUsage(state.db, { periodKey: "2026-09", inputTokens: 100, outputTokens: 50, credits: 0.5 });
    upsertTeamUsage(state.db, { periodKey: "2026-09", inputTokens: 100, outputTokens: 50, credits: 0.5 });
    upsertTeamUsage(state.db, { periodKey: "2026-10", inputTokens: 7, outputTokens: 8, credits: 0.25 });
    // Omitted counters default to 0 (no NULL poisoning of the additive update).
    upsertTeamUsage(state.db, { periodKey: "2026-10" });

    await expect(getTeamUsage("2026-09")).resolves.toEqual({
      periodKey: "2026-09", inputTokens: 200, outputTokens: 100, credits: 1,
    });
    await expect(getTeamUsage("2026-10")).resolves.toEqual({
      periodKey: "2026-10", inputTokens: 7, outputTokens: 8, credits: 0.25,
    });
  });

  it("participates in an enclosing transaction (rolled back on failure)", async () => {
    state.db = await makeDb(["teamUsage"]);
    upsertTeamUsage(state.db, { periodKey: "2026-09", inputTokens: 1, outputTokens: 1, credits: 1 });

    expect(() => state.db.transaction(() => {
      upsertTeamUsage(state.db, { periodKey: "2026-09", inputTokens: 99, outputTokens: 99, credits: 99 });
      throw new Error("abort");
    })).toThrow("abort");

    await expect(getTeamUsage("2026-09")).resolves.toEqual({
      periodKey: "2026-09", inputTokens: 1, outputTokens: 1, credits: 1,
    });
  });

  it("reset clears every period", async () => {
    state.db = await makeDb(["teamUsage"]);
    upsertTeamUsage(state.db, { periodKey: "2026-09", inputTokens: 1, outputTokens: 2, credits: 3 });
    upsertTeamUsage(state.db, { periodKey: "2026-10", inputTokens: 4, outputTokens: 5, credits: 6 });

    await expect(resetTeamUsage()).resolves.toBe(true);

    await expect(getTeamUsage("2026-09")).resolves.toEqual({
      periodKey: "2026-09", inputTokens: 0, outputTokens: 0, credits: 0,
    });
    await expect(getTeamUsage("2026-10")).resolves.toEqual({
      periodKey: "2026-10", inputTokens: 0, outputTokens: 0, credits: 0,
    });
    const { n } = state.db.get(`SELECT COUNT(*) AS n FROM teamUsage`);
    expect(n).toBe(0);
  });
});
