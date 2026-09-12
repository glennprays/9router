// Convert the pre-v4 raw-secret usage identity to immutable apiKeys.id.
// The migration is intentionally a no-op when a fresh database already has the
// final apiKeyId shape (001 creates TABLES using the current schema).
const migration = {
  version: 4,
  name: "api-key-usage-api-key-id",
  up(db) {
    const columns = db.all("PRAGMA table_info(apiKeyUsage)").map((row) => row.name);
    if (!columns.includes("key") || columns.includes("apiKeyId")) return;

    db.exec(`
      CREATE TABLE apiKeyUsage_new (
        apiKeyId TEXT NOT NULL,
        periodKey TEXT NOT NULL,
        inputTokens INTEGER DEFAULT 0,
        outputTokens INTEGER DEFAULT 0,
        credits REAL DEFAULT 0,
        updatedAt TEXT,
        PRIMARY KEY (apiKeyId, periodKey)
      )
    `);
    db.exec(`
      INSERT INTO apiKeyUsage_new(apiKeyId, periodKey, inputTokens, outputTokens, credits, updatedAt)
      SELECT k.id, u.periodKey, u.inputTokens, u.outputTokens, u.credits, u.updatedAt
      FROM apiKeyUsage u
      INNER JOIN apiKeys k ON k.key = u.key
    `);
    db.exec("DROP TABLE apiKeyUsage");
    db.exec("ALTER TABLE apiKeyUsage_new RENAME TO apiKeyUsage");
    db.exec("CREATE INDEX IF NOT EXISTS idx_aku_period ON apiKeyUsage(periodKey)");
  },
};
export default migration;
