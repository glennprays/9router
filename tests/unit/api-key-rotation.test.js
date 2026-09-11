import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: null }));

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => state.db),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "content-type": "application/json" },
      });
    },
  },
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn(async () => "fallbackmachine1"),
}));

import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";
import { TABLES, buildCreateTableSql } from "../../src/lib/db/schema.js";
import {
  getApiKeyById,
  rotateApiKey,
  validateApiKey,
} from "../../src/lib/db/repos/apiKeysRepo.js";
import { getApiKeyUsage } from "../../src/lib/db/repos/apiKeyUsageRepo.js";
import { POST as rotateRoute } from "../../src/app/api/keys/[id]/rotate/route.js";

let tempDbPath;

async function makeDb() {
  tempDbPath = path.join(os.tmpdir(), `9router-api-key-rotation-${process.pid}-${Date.now()}.sqlite`);
  const db = await createSqlJsAdapter(tempDbPath);
  for (const tableName of ["apiKeys", "apiKeyUsage", "usageHistory"]) {
    const table = TABLES[tableName];
    db.exec(buildCreateTableSql(tableName, table));
    for (const index of table.indexes || []) db.exec(index);
  }
  return db;
}

function seedKey(overrides = {}) {
  const key = {
    id: "key-1",
    key: "sk-old-secret",
    name: "Production key",
    machineId: "machine-123",
    isActive: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    inputTokensMonthly: 100,
    outputTokensMonthly: 200,
    creditsMonthly: 3.5,
    ...overrides,
  };
  state.db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, inputTokensMonthly, outputTokensMonthly, creditsMonthly)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [key.id, key.key, key.name, key.machineId, key.isActive, key.createdAt,
      key.inputTokensMonthly, key.outputTokensMonthly, key.creditsMonthly]
  );
  return key;
}

async function responseJson(response) {
  return { status: response.status, body: await response.json() };
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

describe("rotateApiKey", () => {
  it("rotates the secret, migrates usage, preserves policy, and leaves history auditable", async () => {
    const oldKey = seedKey();
    state.db.run(
      `INSERT INTO apiKeyUsage(key, periodKey, inputTokens, outputTokens, credits, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [oldKey.key, "2026-09", 10, 20, 1.25, "2026-09-10T00:00:00.000Z"]
    );
    state.db.run(
      `INSERT INTO apiKeyUsage(key, periodKey, inputTokens, outputTokens, credits, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [oldKey.key, "2026-08", 3, 4, 0.5, "2026-08-10T00:00:00.000Z"]
    );
    state.db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["2026-09-10T00:00:00.000Z", "kiro", "claude-haiku", oldKey.key, 10, 20, 1.25]
    );

    const result = await rotateApiKey(oldKey.id);

    expect(result).toMatchObject({ id: oldKey.id });
    expect(result.key).toMatch(/^sk-machine-123-/);
    expect(result.key).not.toBe(oldKey.key);
    expect(await validateApiKey(oldKey.key)).toBe(false);
    expect(await validateApiKey(result.key)).toBe(true);
    expect(await getApiKeyById(oldKey.id)).toMatchObject({
      id: oldKey.id,
      key: result.key,
      name: oldKey.name,
      machineId: oldKey.machineId,
      isActive: true,
      inputTokensMonthly: oldKey.inputTokensMonthly,
      outputTokensMonthly: oldKey.outputTokensMonthly,
      creditsMonthly: oldKey.creditsMonthly,
    });
    await expect(getApiKeyUsage(result.key, "2026-09")).resolves.toMatchObject({
      key: result.key, inputTokens: 10, outputTokens: 20, credits: 1.25,
    });
    await expect(getApiKeyUsage(result.key, "2026-08")).resolves.toMatchObject({
      key: result.key, inputTokens: 3, outputTokens: 4, credits: 0.5,
    });
    expect(state.db.get("SELECT apiKey FROM usageHistory WHERE id = 1").apiKey).toBe(oldKey.key);
    expect(state.db.all("SELECT key FROM apiKeyUsage")).toHaveLength(2);
    expect(state.db.all("SELECT key FROM apiKeyUsage").every((row) => row.key === result.key)).toBe(true);
  });

  it("rolls back the API-key update when usage migration fails", async () => {
    const oldKey = seedKey();
    state.db.run(
      `INSERT INTO apiKeyUsage(key, periodKey, inputTokens, outputTokens, credits)
       VALUES (?, ?, ?, ?, ?)`,
      [oldKey.key, "2026-09", 10, 20, 1.25]
    );
    state.db.exec(`CREATE TRIGGER fail_key_usage_migration BEFORE UPDATE ON apiKeyUsage
      BEGIN SELECT RAISE(ABORT, 'migration failed'); END;`);

    await expect(rotateApiKey(oldKey.id)).rejects.toThrow("migration failed");
    expect((await getApiKeyById(oldKey.id)).key).toBe(oldKey.key);
    expect(await validateApiKey(oldKey.key)).toBe(true);
    expect(state.db.get("SELECT key FROM apiKeyUsage WHERE periodKey = '2026-09'").key).toBe(oldKey.key);
  });

  it("derives a machine id for legacy rows that have none instead of minting sk-null keys", async () => {
    const legacy = seedKey({ machineId: null });

    const result = await rotateApiKey(legacy.id);

    expect(result.key).toMatch(/^sk-fallbackmachine1-/);
    expect(await validateApiKey(result.key)).toBe(true);
    expect(await getApiKeyById(legacy.id)).toMatchObject({ key: result.key, machineId: "fallbackmachine1" });
  });

  it("returns null for an unknown id", async () => {
    await expect(rotateApiKey("missing-key")).resolves.toBeNull();
  });
});

describe("POST /api/keys/[id]/rotate", () => {
  it("returns the new secret exactly once with 201", async () => {
    const oldKey = seedKey();
    const response = await rotateRoute(
      new Request("http://localhost/api/keys/key-1/rotate", { method: "POST" }),
      { params: Promise.resolve({ id: oldKey.id }) }
    );
    const result = await responseJson(response);

    expect(result.status).toBe(201);
    expect(Object.keys(result.body)).toEqual(["key"]);
    expect(result.body.key).toMatch(/^sk-machine-123-/);
  });

  it("returns the exact 404 body for an unknown id", async () => {
    const result = await responseJson(await rotateRoute(
      new Request("http://localhost/api/keys/missing/rotate", { method: "POST" }),
      { params: Promise.resolve({ id: "missing-key" }) }
    ));

    expect(result).toEqual({ status: 404, body: { error: "Key not found" } });
  });
});
