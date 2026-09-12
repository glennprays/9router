import { getAdapter } from "../driver.js";
import { parseJson } from "../helpers/jsonCol.js";

export function monthKey(timestamp = new Date().toISOString()) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export async function getApiKeyUsage(apiKeyId, periodKey = monthKey()) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT apiKeyId, periodKey, inputTokens, outputTokens, credits
     FROM apiKeyUsage WHERE apiKeyId = ? AND periodKey = ?`,
    [apiKeyId, periodKey]
  );
  if (!row) return { apiKeyId, periodKey, inputTokens: 0, outputTokens: 0, credits: 0 };
  return {
    apiKeyId: row.apiKeyId,
    periodKey: row.periodKey,
    inputTokens: row.inputTokens || 0,
    outputTokens: row.outputTokens || 0,
    credits: row.credits || 0,
  };
}

// Synchronous: takes an already-open adapter so it can run inside an
// existing db.transaction() (see usageRepo.saveRequestUsage).
export function upsertApiKeyUsage(db, { apiKeyId, periodKey, inputTokens = 0, outputTokens = 0, credits = 0 }) {
  db.run(
    `INSERT INTO apiKeyUsage(apiKeyId, periodKey, inputTokens, outputTokens, credits, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(apiKeyId, periodKey) DO UPDATE SET
       inputTokens = inputTokens + excluded.inputTokens,
       outputTokens = outputTokens + excluded.outputTokens,
       credits = credits + excluded.credits,
       updatedAt = excluded.updatedAt`,
    [apiKeyId, periodKey, inputTokens, outputTokens, credits, new Date().toISOString()]
  );
}

// Empirical credits-per-total-token for one Kiro model, from recent history.
const _rateCache = new Map();
const RATE_TTL_MS = 5 * 60 * 1000;

export async function getKiroCreditRate(model) {
  const cached = _rateCache.get(model);
  if (cached && Date.now() - cached.ts < RATE_TTL_MS) return cached.rate;

  const db = await getAdapter();
  const iso30dAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.all(
    `SELECT tokens FROM usageHistory
     WHERE provider = 'kiro' AND model = ? AND timestamp >= ?
     ORDER BY id DESC LIMIT 500`,
    [model, iso30dAgo]
  );

  let sumCredits = 0;
  let sumTokens = 0;
  for (const r of rows) {
    const t = parseJson(r.tokens, null);
    if (!t) continue;
    const credits = Number(t.kiro_credits);
    const total = Number(t.total_tokens);
    if (Number.isFinite(credits) && credits > 0 && Number.isFinite(total) && total > 0) {
      sumCredits += credits;
      sumTokens += total;
    }
  }

  const rate = sumTokens > 0 ? sumCredits / sumTokens : 0;
  _rateCache.set(model, { rate, ts: Date.now() });
  return rate;
}

export async function resetApiKeyUsageById(id, periodKey = monthKey()) {
  if (!id) return false;
  const db = await getAdapter();
  let exists = false;
  db.transaction(() => {
    exists = Boolean(db.get(`SELECT id FROM apiKeys WHERE id = ?`, [id]));
    if (!exists) return;
    db.run(
      `DELETE FROM apiKeyUsage WHERE apiKeyId = ? AND periodKey = ?`,
      [id, periodKey]
    );
    db.run(
      `DELETE FROM apiKeyProviderUsage WHERE apiKeyId = ? AND periodKey = ?`,
      [id, periodKey]
    );
  });
  return exists;
}

export function deleteApiKeyUsageByIdSync(db, id) {
  db.run(`DELETE FROM apiKeyUsage WHERE apiKeyId = ?`, [id]);
}

export async function deleteApiKeyUsageById(id) {
  const db = await getAdapter();
  deleteApiKeyUsageByIdSync(db, id);
  return true;
}

