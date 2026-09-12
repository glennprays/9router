// Verify schema migration chain runs correctly across versions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mig-"));
  process.env.DATA_DIR = tempDir;
  // Reset global singleton so each test gets fresh adapter pointed at tempDir
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  // Close adapter to release file handles before rm
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Schema migrations", () => {
  it("fresh DB → applies migrations & stamps schemaVersion", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db = await getAdapter();
    const row = db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const tables = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map(t => t.name);
    expect(tables).toEqual(expect.arrayContaining([
      "_meta", "settings", "providerConnections", "providerNodes",
      "proxyPools", "apiKeys", "apiKeyUsage", "apiKeyProviderBudget", "apiKeyProviderUsage",
      "combos", "kv", "usageHistory", "usageDaily", "requestDetails",
      "teamBudgetPolicy", "teamUsage", "kiroAccountBudget", "kiroAccountUsage",
    ]));
    expect(db.all(`PRAGMA index_list(apiKeyProviderBudget)`).map(i => i.name)).toContain("idx_akpb_key");
    expect(db.all(`PRAGMA index_list(apiKeyProviderUsage)`).map(i => i.name)).toContain("idx_akpu_key_period");
  });

  it("existing DB at older schemaVersion → re-applies pending migrations on restart", async () => {
    // 1st boot
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, ['{"foo":"bar"}']);
    db.run(`UPDATE _meta SET value = '0' WHERE key = 'schemaVersion'`);
    db.close?.();

    // 2nd boot: full reset to simulate process restart
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db2 = await getAdapter2();
    const row = db2.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const settings = db2.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "bar" });
  });

  it("fresh DB + legacy db.json → imports data automatically", async () => {
    // Simulate user upgrading: place legacy JSON in DATA_DIR before first boot
    const legacy = {
      settings: { foo: "legacy-value" },
      apiKeys: [{ id: "k1", key: "abc", name: "test", createdAt: new Date().toISOString() }],
      modelAliases: { "gpt-4": "gpt-4-turbo" },
    };
    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify(legacy));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const settings = db.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "legacy-value" });

    const keys = db.all(`SELECT * FROM apiKeys`);
    expect(keys).toHaveLength(1);
    expect(keys[0].key).toBe("abc");

    const aliases = db.all(`SELECT * FROM kv WHERE scope='modelAliases'`);
    expect(aliases).toHaveLength(1);
  });

  it("backfills current-month usage by stable key id across providers and skips orphans", async () => {
    const now = new Date();
    const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const previousPeriod = `${now.getFullYear()}-${String(now.getMonth()).padStart(2, "0")}`;
    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify({
      apiKeys: [
        { id: "k1", key: "legacy-key", name: "legacy", createdAt: now.toISOString() },
      ],
    }));
    fs.writeFileSync(path.join(tempDir, "usage.json"), JSON.stringify({
      history: [
        {
          timestamp: now.toISOString(),
          provider: "openai",
          model: "gpt-test",
          apiKey: "legacy-key",
          tokens: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        },
        {
          timestamp: now.toISOString(),
          provider: "kiro",
          model: "claude-haiku",
          apiKey: "legacy-key",
          tokens: { prompt_tokens: 4, completion_tokens: 2, kiro_credits: 1.25 },
        },
        {
          timestamp: now.toISOString(),
          provider: "openai",
          model: "gpt-test",
          apiKey: "orphan-key",
          tokens: { prompt_tokens: 99, completion_tokens: 99 },
        },
      ],
    }));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    expect(db.get("SELECT apiKeyId, inputTokens, outputTokens, credits FROM apiKeyUsage WHERE apiKeyId = ?", ["k1"]))
      .toMatchObject({ apiKeyId: "k1", inputTokens: 16, outputTokens: 5, credits: 1.25 });
    expect(db.all("SELECT apiKeyId, provider, inputTokens, outputTokens, credits FROM apiKeyProviderUsage"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ apiKeyId: "k1", provider: "openai", inputTokens: 12, outputTokens: 3, credits: 0 }),
        expect.objectContaining({ apiKeyId: "k1", provider: "kiro", inputTokens: 4, outputTokens: 2, credits: 1.25 }),
      ]));
    expect(db.get("SELECT COUNT(*) AS count FROM apiKeyProviderUsage").count).toBe(2);
    expect(db.get("SELECT value FROM _meta WHERE key = 'apiKeyUsageBackfilledV4'").value).toBe("1");
    expect(currentPeriod).toMatch(/^\d{4}-\d{2}$/);
    expect(previousPeriod).toMatch(/^\d{4}-\d{2}$/);
  });
  it("converts legacy raw-key usage rows to live key ids before additive sync", async () => {
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    fs.mkdirSync(path.join(tempDir, "db"), { recursive: true });
    const old = await createSqlJsAdapter(path.join(tempDir, "db", "data.sqlite"));
    old.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL);
      CREATE TABLE apiKeyUsage (
        key TEXT NOT NULL,
        periodKey TEXT NOT NULL,
        inputTokens INTEGER DEFAULT 0,
        outputTokens INTEGER DEFAULT 0,
        credits REAL DEFAULT 0,
        updatedAt TEXT,
        PRIMARY KEY (key, periodKey)
      );
    `);
    old.run("INSERT INTO _meta(key, value) VALUES('schemaVersion', '3')");
    old.run("INSERT INTO apiKeys(id, key, createdAt) VALUES('k1', 'live-key', ?)", [new Date().toISOString()]);
    old.run("INSERT INTO apiKeyUsage(key, periodKey, inputTokens) VALUES('live-key', '2026-08', 7)");
    old.run("INSERT INTO apiKeyUsage(key, periodKey, inputTokens) VALUES('orphan-key', '2026-08', 99)");
    old.close();

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const columns = db.all("PRAGMA table_info(apiKeyUsage)").map((row) => row.name);
    expect(columns).toContain("apiKeyId");
    expect(columns).not.toContain("key");
    expect(db.get("SELECT apiKeyId, inputTokens FROM apiKeyUsage WHERE periodKey = '2026-08'"))
      .toMatchObject({ apiKeyId: "k1", inputTokens: 7 });
    expect(db.get("SELECT COUNT(*) AS count FROM apiKeyUsage WHERE periodKey = '2026-08'").count).toBe(1);
  });

  it("auto-sync re-creates missing index when DB lacks it", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.exec(`DROP INDEX IF EXISTS idx_pn_type`);
    expect(db.all(`PRAGMA index_list(providerNodes)`).map(i => i.name)).not.toContain("idx_pn_type");
    db.close?.();

    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();
    const idx = db2.all(`PRAGMA index_list(providerNodes)`).map(i => i.name);
    expect(idx).toContain("idx_pn_type");
  });
});
