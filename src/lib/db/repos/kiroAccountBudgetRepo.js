import { getAdapter } from "../driver.js";
import { monthKey } from "./apiKeyUsageRepo.js";

// Per-Kiro-account monthly credit ceilings, keyed by provider connection id.
// A null creditsMonthly (or no row at all) means unlimited.
export async function getKiroAccountBudgets() {
  const db = await getAdapter();
  const rows = db.all(`SELECT connectionId, creditsMonthly FROM kiroAccountBudget`);
  return new Map(rows.map((r) => [r.connectionId, r.creditsMonthly ?? null]));
}

export async function getKiroAccountBudget(connectionId) {
  const db = await getAdapter();
  const row = db.get(`SELECT creditsMonthly FROM kiroAccountBudget WHERE connectionId = ?`, [connectionId]);
  return row?.creditsMonthly ?? null;
}

export async function setKiroAccountBudget(connectionId, creditsMonthly = null) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO kiroAccountBudget(connectionId, creditsMonthly, updatedAt)
     VALUES(?, ?, ?)
     ON CONFLICT(connectionId) DO UPDATE SET
       creditsMonthly = excluded.creditsMonthly,
       updatedAt = excluded.updatedAt`,
    [connectionId, creditsMonthly, new Date().toISOString()]
  );
  return { connectionId, creditsMonthly };
}

export async function getKiroAccountUsage(connectionId, periodKey = monthKey()) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT connectionId, periodKey, credits FROM kiroAccountUsage WHERE connectionId = ? AND periodKey = ?`,
    [connectionId, periodKey]
  );
  if (!row) return { connectionId, periodKey, credits: 0 };
  return { connectionId: row.connectionId, periodKey: row.periodKey, credits: row.credits || 0 };
}

export async function getAllKiroAccountUsage(periodKey = monthKey()) {
  const db = await getAdapter();
  const rows = db.all(`SELECT connectionId, credits FROM kiroAccountUsage WHERE periodKey = ?`, [periodKey]);
  return new Map(rows.map((r) => [r.connectionId, r.credits || 0]));
}

// Synchronous: takes an already-open adapter so it can run inside an
// existing db.transaction() (see usageRepo.saveRequestUsage).
export function upsertKiroAccountUsage(db, { connectionId, periodKey, credits = 0 }) {
  db.run(
    `INSERT INTO kiroAccountUsage(connectionId, periodKey, credits, updatedAt)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(connectionId, periodKey) DO UPDATE SET
       credits = credits + excluded.credits,
       updatedAt = excluded.updatedAt`,
    [connectionId, periodKey, credits, new Date().toISOString()]
  );
}

export async function resetKiroAccountUsageByConnectionId(connectionId) {
  const db = await getAdapter();
  db.run(`DELETE FROM kiroAccountUsage WHERE connectionId = ?`, [connectionId]);
  return true;
}
