import { getAdapter } from "../driver.js";
import { monthKey } from "./apiKeyUsageRepo.js";

// Singleton policy row (id = 1). A null limit means unlimited.
export async function getTeamBudgetPolicy() {
  const db = await getAdapter();
  const row = db.get(
    `SELECT inputTokensMonthly, outputTokensMonthly, creditsMonthly FROM teamBudgetPolicy WHERE id = 1`
  );
  if (!row) return null;
  return {
    inputTokensMonthly: row.inputTokensMonthly ?? null,
    outputTokensMonthly: row.outputTokensMonthly ?? null,
    creditsMonthly: row.creditsMonthly ?? null,
  };
}

export async function setTeamBudgetPolicy({
  inputTokensMonthly = null,
  outputTokensMonthly = null,
  creditsMonthly = null,
} = {}) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO teamBudgetPolicy(id, inputTokensMonthly, outputTokensMonthly, creditsMonthly, updatedAt)
     VALUES(1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       inputTokensMonthly = excluded.inputTokensMonthly,
       outputTokensMonthly = excluded.outputTokensMonthly,
       creditsMonthly = excluded.creditsMonthly,
       updatedAt = excluded.updatedAt`,
    [inputTokensMonthly, outputTokensMonthly, creditsMonthly, new Date().toISOString()]
  );
  return { inputTokensMonthly, outputTokensMonthly, creditsMonthly };
}

export async function getTeamUsage(periodKey = monthKey()) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT periodKey, inputTokens, outputTokens, credits FROM teamUsage WHERE periodKey = ?`,
    [periodKey]
  );
  if (!row) return { periodKey, inputTokens: 0, outputTokens: 0, credits: 0 };
  return {
    periodKey: row.periodKey,
    inputTokens: row.inputTokens || 0,
    outputTokens: row.outputTokens || 0,
    credits: row.credits || 0,
  };
}

// Synchronous: takes an already-open adapter so it can run inside an
// existing db.transaction() (see usageRepo.saveRequestUsage).
export function upsertTeamUsage(db, { periodKey, inputTokens = 0, outputTokens = 0, credits = 0 }) {
  db.run(
    `INSERT INTO teamUsage(periodKey, inputTokens, outputTokens, credits, updatedAt)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(periodKey) DO UPDATE SET
       inputTokens = inputTokens + excluded.inputTokens,
       outputTokens = outputTokens + excluded.outputTokens,
       credits = credits + excluded.credits,
       updatedAt = excluded.updatedAt`,
    [periodKey, inputTokens, outputTokens, credits, new Date().toISOString()]
  );
}

export async function resetTeamUsage() {
  const db = await getAdapter();
  db.run(`DELETE FROM teamUsage`);
  return true;
}
