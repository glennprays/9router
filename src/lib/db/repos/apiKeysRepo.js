import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { monthKey } from "./apiKeyUsageRepo.js";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    inputTokensMonthly: row.inputTokensMonthly,
    outputTokensMonthly: row.outputTokensMonthly,
    creditsMonthly: row.creditsMonthly,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, limits = {}) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    inputTokensMonthly: limits.inputTokensMonthly ?? null,
    outputTokensMonthly: limits.outputTokensMonthly ?? null,
    creditsMonthly: limits.creditsMonthly ?? null,
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, inputTokensMonthly, outputTokensMonthly, creditsMonthly) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt,
      apiKey.inputTokensMonthly, apiKey.outputTokensMonthly, apiKey.creditsMonthly,
    ]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, inputTokensMonthly = ?, outputTokensMonthly = ?, creditsMonthly = ? WHERE id = ?`,
      [
        merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0,
        merged.inputTokensMonthly ?? null, merged.outputTokensMonthly ?? null,
        merged.creditsMonthly ?? null, id,
      ]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}

export async function getApiKeyPolicyByKey(key) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT id, key, isActive, inputTokensMonthly, outputTokensMonthly, creditsMonthly FROM apiKeys WHERE key = ?`,
    [key]
  );
  return row || null;
}

export async function getApiKeysWithUsage() {
  const db = await getAdapter();
  const keys = (await getApiKeys());
  const period = monthKey();
  const rows = db.all(
    `SELECT key, inputTokens, outputTokens, credits FROM apiKeyUsage WHERE periodKey = ?`,
    [period]
  );
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return keys.map((k) => {
    const u = byKey.get(k.key);
    return {
      ...k,
      usage: {
        periodKey: period,
        inputTokens: u?.inputTokens || 0,
        outputTokens: u?.outputTokens || 0,
        credits: u?.credits || 0,
      },
    };
  });
}
export async function rotateApiKey(id) {
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT id, key, machineId FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const { key: newKey } = generateApiKeyWithMachine(row.machineId);
    db.run(`UPDATE apiKeys SET key = ? WHERE id = ?`, [newKey, id]);
    db.run(`UPDATE apiKeyUsage SET key = ? WHERE key = ?`, [newKey, row.key]);
    result = { id, key: newKey };
  });
  return result;
}
