import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import {
  deleteApiKeyUsageByIdSync,
  monthKey,
} from "./apiKeyUsageRepo.js";
import {
  deleteApiKeyProviderDataSync,
  getApiKeyProviderBudgets,
  replaceApiKeyProviderBudgetsSync,
} from "./apiKeyProviderBudgetRepo.js";
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
  db.transaction(() => {
    db.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, inputTokensMonthly, outputTokensMonthly, creditsMonthly) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt,
        apiKey.inputTokensMonthly, apiKey.outputTokensMonthly, apiKey.creditsMonthly,
      ]
    );
    replaceApiKeyProviderBudgetsSync(db, apiKey.id, limits.providerBudgets);
  });
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  const hasProviderBudgets = Object.prototype.hasOwnProperty.call(data, "providerBudgets");
  const { providerBudgets, ...keyData } = data;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...keyData };
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, inputTokensMonthly = ?, outputTokensMonthly = ?, creditsMonthly = ? WHERE id = ?`,
      [
        merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0,
        merged.inputTokensMonthly ?? null, merged.outputTokensMonthly ?? null,
        merged.creditsMonthly ?? null, id,
      ]
    );
    if (hasProviderBudgets) replaceApiKeyProviderBudgetsSync(db, id, providerBudgets);
    result = {
      ...merged,
      ...(hasProviderBudgets ? { providerBudgets: providerBudgets ?? null } : {}),
    };
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  let deleted = false;
  db.transaction(() => {
    const result = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
    if ((result?.changes ?? 0) === 0) return;
    deleteApiKeyUsageByIdSync(db, id);
    deleteApiKeyProviderDataSync(db, id);
    deleted = true;
  });
  return deleted;
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
  const keys = await getApiKeys();
  const period = monthKey();
  const rows = db.all(
    `SELECT apiKeyId, inputTokens, outputTokens, credits
     FROM apiKeyUsage WHERE periodKey = ?`,
    [period]
  );
  const byKey = new Map(rows.map((r) => [r.apiKeyId, r]));
  return Promise.all(keys.map(async (k) => {
    const u = byKey.get(k.id);
    return {
      ...k,
      usage: {
        periodKey: period,
        inputTokens: u?.inputTokens || 0,
        outputTokens: u?.outputTokens || 0,
        credits: u?.credits || 0,
      },
      providerBudgets: await getApiKeyProviderBudgets(k.id, period),
    };
  }));
}
export async function rotateApiKey(id) {
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const row = db.get(`SELECT id, machineId FROM apiKeys WHERE id = ?`, [id]);
  if (!row) return null;
  // Rows imported from legacy db.json carry machineId NULL; embedding "null" in the
  // secret would still pass the CRC check but is not a real machine-bound key.
  let machineId = row.machineId;
  if (!machineId) {
    const { getConsistentMachineId } = await import("@/shared/utils/machineId");
    machineId = await getConsistentMachineId();
  }
  let result = null;
  db.transaction(() => {
    const current = db.get(`SELECT id FROM apiKeys WHERE id = ?`, [id]);
    if (!current) return;
    const { key: newKey } = generateApiKeyWithMachine(machineId);
    db.run(`UPDATE apiKeys SET key = ?, machineId = ? WHERE id = ?`, [newKey, machineId, id]);
    result = { id, key: newKey };
  });
  return result;
}
