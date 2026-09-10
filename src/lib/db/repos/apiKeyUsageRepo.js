import { getAdapter } from "../driver.js";
import { parseJson } from "../helpers/jsonCol.js";

export function monthKey(timestamp = new Date().toISOString()) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export async function getApiKeyUsage(key, periodKey = monthKey()) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT key, periodKey, inputTokens, outputTokens, credits FROM apiKeyUsage WHERE key = ? AND periodKey = ?`,
    [key, periodKey]
  );
  if (!row) return { key, periodKey, inputTokens: 0, outputTokens: 0, credits: 0 };
  return {
    key: row.key,
    periodKey: row.periodKey,
    inputTokens: row.inputTokens || 0,
    outputTokens: row.outputTokens || 0,
    credits: row.credits || 0,
  };
}

// Synchronous: takes an already-open adapter so it can run inside an
// existing db.transaction() (see usageRepo.saveRequestUsage).
export function upsertApiKeyUsage(db, { key, periodKey, inputTokens = 0, outputTokens = 0, credits = 0 }) {
  db.run(
    `INSERT INTO apiKeyUsage(key, periodKey, inputTokens, outputTokens, credits, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(key, periodKey) DO UPDATE SET
       inputTokens = inputTokens + excluded.inputTokens,
       outputTokens = outputTokens + excluded.outputTokens,
       credits = credits + excluded.credits,
       updatedAt = excluded.updatedAt`,
    [key, periodKey, inputTokens, outputTokens, credits, new Date().toISOString()]
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

export async function resetApiKeyUsageByKey(key) {
  const db = await getAdapter();
  db.run(`DELETE FROM apiKeyUsage WHERE key = ?`, [key]);
  return true;
}

export async function resetApiKeyUsageById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT key FROM apiKeys WHERE id = ?`, [id]);
  if (!row || !row.key) return false;
  return resetApiKeyUsageByKey(row.key);
}
