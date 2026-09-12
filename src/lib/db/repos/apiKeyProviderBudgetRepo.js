import { getAdapter } from "../driver.js";
import { monthKey } from "./apiKeyUsageRepo.js";

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizePolicy(policy = {}) {
  return {
    provider: policy.provider,
    inputTokensMonthly: policy.inputTokensMonthly ?? null,
    outputTokensMonthly: policy.outputTokensMonthly ?? null,
    creditsMonthly: policy.creditsMonthly ?? null,
  };
}

function hasLimit(policy) {
  return policy.inputTokensMonthly != null
    || policy.outputTokensMonthly != null
    || policy.creditsMonthly != null;
}

export function replaceApiKeyProviderBudgetsSync(db, apiKeyId, budgets) {
  db.run(`DELETE FROM apiKeyProviderBudget WHERE apiKeyId = ?`, [apiKeyId]);
  for (const input of Array.isArray(budgets) ? budgets : []) {
    const policy = normalizePolicy(input);
    if (!policy.provider || !hasLimit(policy)) continue;
    db.run(
      `INSERT INTO apiKeyProviderBudget(apiKeyId, provider, inputTokensMonthly, outputTokensMonthly, creditsMonthly, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(apiKeyId, provider) DO UPDATE SET
         inputTokensMonthly = excluded.inputTokensMonthly,
         outputTokensMonthly = excluded.outputTokensMonthly,
         creditsMonthly = excluded.creditsMonthly,
         updatedAt = excluded.updatedAt`,
      [
        apiKeyId,
        policy.provider,
        policy.inputTokensMonthly,
        policy.outputTokensMonthly,
        policy.creditsMonthly,
        new Date().toISOString(),
      ]
    );
  }
}

export async function getApiKeyProviderBudgets(apiKeyId, periodKey = monthKey()) {
  if (!apiKeyId) return [];
  const db = await getAdapter();
  const rows = db.all(
    `WITH providers AS (
       SELECT provider FROM apiKeyProviderBudget WHERE apiKeyId = ?
       UNION
       SELECT provider FROM apiKeyProviderUsage WHERE apiKeyId = ? AND periodKey = ?
     )
     SELECT
       p.provider,
       b.inputTokensMonthly,
       b.outputTokensMonthly,
       b.creditsMonthly,
       u.periodKey AS usagePeriodKey,
       u.inputTokens,
       u.outputTokens,
       u.credits
     FROM providers p
     LEFT JOIN apiKeyProviderBudget b
       ON b.apiKeyId = ? AND b.provider = p.provider
     LEFT JOIN apiKeyProviderUsage u
       ON u.apiKeyId = ? AND u.provider = p.provider AND u.periodKey = ?
     ORDER BY p.provider ASC`,
    [apiKeyId, apiKeyId, periodKey, apiKeyId, apiKeyId, periodKey]
  );

  return rows.map((row) => ({
    provider: row.provider,
    inputTokensMonthly: row.inputTokensMonthly ?? null,
    outputTokensMonthly: row.outputTokensMonthly ?? null,
    creditsMonthly: row.creditsMonthly ?? null,
    usage: {
      periodKey,
      inputTokens: numberOrZero(row.inputTokens),
      outputTokens: numberOrZero(row.outputTokens),
      credits: numberOrZero(row.credits),
    },
  }));
}

export async function replaceApiKeyProviderBudgets(apiKeyId, budgets) {
  const db = await getAdapter();
  db.transaction(() => replaceApiKeyProviderBudgetsSync(db, apiKeyId, budgets));
  return getApiKeyProviderBudgets(apiKeyId);
}

export function upsertApiKeyProviderUsage(db, {
  apiKeyId,
  provider,
  periodKey,
  inputTokens = 0,
  outputTokens = 0,
  credits = 0,
}) {
  db.run(
    `INSERT INTO apiKeyProviderUsage(apiKeyId, provider, periodKey, inputTokens, outputTokens, credits, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(apiKeyId, provider, periodKey) DO UPDATE SET
       inputTokens = inputTokens + excluded.inputTokens,
       outputTokens = outputTokens + excluded.outputTokens,
       credits = credits + excluded.credits,
       updatedAt = excluded.updatedAt`,
    [apiKeyId, provider, periodKey, inputTokens, outputTokens, credits, new Date().toISOString()]
  );
}

export async function getApiKeyProviderUsage(apiKeyId, periodKey = monthKey()) {
  if (!apiKeyId) return [];
  const db = await getAdapter();
  return db.all(
    `SELECT provider, periodKey, inputTokens, outputTokens, credits
     FROM apiKeyProviderUsage
     WHERE apiKeyId = ? AND periodKey = ?
     ORDER BY provider ASC`,
    [apiKeyId, periodKey]
  ).map((row) => ({
    provider: row.provider,
    periodKey: row.periodKey,
    inputTokens: numberOrZero(row.inputTokens),
    outputTokens: numberOrZero(row.outputTokens),
    credits: numberOrZero(row.credits),
  }));
}

export async function resetApiKeyProviderUsage(apiKeyId, provider, periodKey = monthKey()) {
  const db = await getAdapter();
  const result = db.run(
    `DELETE FROM apiKeyProviderUsage WHERE apiKeyId = ? AND provider = ? AND periodKey = ?`,
    [apiKeyId, provider, periodKey]
  );
  return (result?.changes ?? 0) > 0;
}

export function deleteApiKeyProviderDataSync(db, apiKeyId) {
  db.run(`DELETE FROM apiKeyProviderBudget WHERE apiKeyId = ?`, [apiKeyId]);
  db.run(`DELETE FROM apiKeyProviderUsage WHERE apiKeyId = ?`, [apiKeyId]);
}

export async function deleteApiKeyProviderData(apiKeyId) {
  const db = await getAdapter();
  db.transaction(() => deleteApiKeyProviderDataSync(db, apiKeyId));
  return true;
}
