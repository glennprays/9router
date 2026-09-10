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
  getKiroAccountBudgets,
  getKiroAccountBudget,
  setKiroAccountBudget,
  getKiroAccountUsage,
  getAllKiroAccountUsage,
  upsertKiroAccountUsage,
  resetKiroAccountUsageByConnectionId,
} from "../../src/lib/db/repos/kiroAccountBudgetRepo.js";

let tempDbPath;

async function makeDb(tableNames) {
  tempDbPath = path.join(os.tmpdir(), `9router-kiro-account-budget-${process.pid}-${Date.now()}.sqlite`);
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

describe("kiro account budgets", () => {
  it("returns an empty map / null when nothing is configured", async () => {
    state.db = await makeDb(["kiroAccountBudget"]);
    await expect(getKiroAccountBudgets()).resolves.toEqual(new Map());
    await expect(getKiroAccountBudget("connA")).resolves.toBeNull();
  });

  it("upserts per connection and preserves null as an explicit unlimited ceiling", async () => {
    state.db = await makeDb(["kiroAccountBudget"]);

    await expect(setKiroAccountBudget("connA", 2000)).resolves.toEqual({ connectionId: "connA", creditsMonthly: 2000 });
    await expect(setKiroAccountBudget("connB", null)).resolves.toEqual({ connectionId: "connB", creditsMonthly: null });

    await expect(getKiroAccountBudget("connA")).resolves.toBe(2000);
    await expect(getKiroAccountBudget("connB")).resolves.toBeNull();
    await expect(getKiroAccountBudgets()).resolves.toEqual(new Map([["connA", 2000], ["connB", null]]));

    // Second write for the same connection replaces the value in place (no duplicate row).
    await expect(setKiroAccountBudget("connA", 1500.5)).resolves.toEqual({ connectionId: "connA", creditsMonthly: 1500.5 });
    await expect(getKiroAccountBudget("connA")).resolves.toBe(1500.5);
    // Clearing back to unlimited keeps the row but nulls the ceiling.
    await expect(setKiroAccountBudget("connA", null)).resolves.toEqual({ connectionId: "connA", creditsMonthly: null });
    await expect(getKiroAccountBudget("connA")).resolves.toBeNull();

    const { n } = state.db.get(`SELECT COUNT(*) AS n FROM kiroAccountBudget`);
    expect(n).toBe(2);
    const { updatedAt } = state.db.get(`SELECT updatedAt FROM kiroAccountBudget WHERE connectionId = ?`, ["connA"]);
    expect(typeof updatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(updatedAt))).toBe(false);
  });

  it("treats an omitted ceiling as unlimited instead of throwing on an undefined bind", async () => {
    state.db = await makeDb(["kiroAccountBudget"]);
    await expect(setKiroAccountBudget("connA")).resolves.toEqual({ connectionId: "connA", creditsMonthly: null });
    await expect(getKiroAccountBudgets()).resolves.toEqual(new Map([["connA", null]]));
  });
});

describe("kiro account usage", () => {
  it("returns zero credits for an unknown account/period and defaults to the current month", async () => {
    state.db = await makeDb(["kiroAccountUsage"]);
    await expect(getKiroAccountUsage("connA", "2026-09")).resolves.toEqual({
      connectionId: "connA", periodKey: "2026-09", credits: 0,
    });
    await expect(getKiroAccountUsage("connA")).resolves.toEqual({
      connectionId: "connA", periodKey: monthKey(), credits: 0,
    });
    await expect(getAllKiroAccountUsage("2026-09")).resolves.toEqual(new Map());
    await expect(getAllKiroAccountUsage()).resolves.toEqual(new Map());
  });

  it("upserts additively per (connectionId, periodKey) and keeps accounts and periods separate", async () => {
    state.db = await makeDb(["kiroAccountUsage"]);

    upsertKiroAccountUsage(state.db, { connectionId: "connA", periodKey: "2026-09", credits: 0.5 });
    upsertKiroAccountUsage(state.db, { connectionId: "connA", periodKey: "2026-09", credits: 1.25 });
    upsertKiroAccountUsage(state.db, { connectionId: "connB", periodKey: "2026-09", credits: 3 });
    upsertKiroAccountUsage(state.db, { connectionId: "connA", periodKey: "2026-10", credits: 7 });
    // Omitted credits default to 0 (no NULL poisoning of the additive update).
    upsertKiroAccountUsage(state.db, { connectionId: "connB", periodKey: "2026-09" });

    await expect(getKiroAccountUsage("connA", "2026-09")).resolves.toEqual({
      connectionId: "connA", periodKey: "2026-09", credits: 1.75,
    });
    await expect(getKiroAccountUsage("connB", "2026-09")).resolves.toEqual({
      connectionId: "connB", periodKey: "2026-09", credits: 3,
    });
    await expect(getKiroAccountUsage("connA", "2026-10")).resolves.toEqual({
      connectionId: "connA", periodKey: "2026-10", credits: 7,
    });

    await expect(getAllKiroAccountUsage("2026-09")).resolves.toEqual(new Map([["connA", 1.75], ["connB", 3]]));
    await expect(getAllKiroAccountUsage("2026-10")).resolves.toEqual(new Map([["connA", 7]]));

    // Default period resolves to monthKey(), whatever month the suite runs in.
    upsertKiroAccountUsage(state.db, { connectionId: "connC", periodKey: monthKey(), credits: 2 });
    const byDefault = await getAllKiroAccountUsage();
    expect(byDefault).toEqual(await getAllKiroAccountUsage(monthKey()));
    expect(byDefault.get("connC")).toBe(2);
  });

  it("participates in an enclosing transaction (rolled back on failure)", async () => {
    state.db = await makeDb(["kiroAccountUsage"]);
    upsertKiroAccountUsage(state.db, { connectionId: "connA", periodKey: "2026-09", credits: 1 });

    expect(() => state.db.transaction(() => {
      upsertKiroAccountUsage(state.db, { connectionId: "connA", periodKey: "2026-09", credits: 99 });
      upsertKiroAccountUsage(state.db, { connectionId: "connZ", periodKey: "2026-09", credits: 99 });
      throw new Error("abort");
    })).toThrow("abort");

    await expect(getKiroAccountUsage("connA", "2026-09")).resolves.toEqual({
      connectionId: "connA", periodKey: "2026-09", credits: 1,
    });
    await expect(getAllKiroAccountUsage("2026-09")).resolves.toEqual(new Map([["connA", 1]]));
  });

  it("reset clears every period for one connection and leaves other accounts untouched", async () => {
    state.db = await makeDb(["kiroAccountUsage"]);
    upsertKiroAccountUsage(state.db, { connectionId: "connA", periodKey: "2026-09", credits: 1 });
    upsertKiroAccountUsage(state.db, { connectionId: "connA", periodKey: "2026-10", credits: 2 });
    upsertKiroAccountUsage(state.db, { connectionId: "connB", periodKey: "2026-09", credits: 3 });

    await expect(resetKiroAccountUsageByConnectionId("connA")).resolves.toBe(true);

    await expect(getKiroAccountUsage("connA", "2026-09")).resolves.toEqual({
      connectionId: "connA", periodKey: "2026-09", credits: 0,
    });
    await expect(getKiroAccountUsage("connA", "2026-10")).resolves.toEqual({
      connectionId: "connA", periodKey: "2026-10", credits: 0,
    });
    await expect(getKiroAccountUsage("connB", "2026-09")).resolves.toEqual({
      connectionId: "connB", periodKey: "2026-09", credits: 3,
    });
    const rows = state.db.all(`SELECT connectionId, periodKey FROM kiroAccountUsage`);
    expect(rows).toEqual([{ connectionId: "connB", periodKey: "2026-09" }]);

    // Resetting an unknown connection is a no-op that still reports success.
    await expect(resetKiroAccountUsageByConnectionId("nope")).resolves.toBe(true);
  });
});
