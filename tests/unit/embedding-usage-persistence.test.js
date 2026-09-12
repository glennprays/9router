import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  handleEmbeddingsCore: vi.fn(),
  saveRequestUsage: vi.fn(),
  getKiroAccountBudgets: vi.fn(),
  getAllKiroAccountUsage: vi.fn(),
  getProviderConnections: vi.fn(),
  getKiroCreditRate: vi.fn(),
  getModelInfo: vi.fn(),
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: () => "client-key",
  isValidApiKey: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
  getApiKeyPolicyByKey: async () => ({ id: "client-id", isActive: true }),
  getApiKeyProviderBudgets: async () => [],
  getApiKeyUsage: async () => ({ inputTokens: 0, outputTokens: 0, credits: 0 }),
  getTeamBudgetPolicy: async () => null,
  getTeamUsage: async () => ({ inputTokens: 0, outputTokens: 0, credits: 0 }),
  getKiroAccountBudgets: mocks.getKiroAccountBudgets,
  getAllKiroAccountUsage: mocks.getAllKiroAccountUsage,
  getProviderConnections: mocks.getProviderConnections,
  getKiroCreditRate: mocks.getKiroCreditRate,
  monthKey: () => "2026-09",
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
}));
vi.mock("../../open-sse/handlers/embeddingsCore.js", () => ({
  handleEmbeddingsCore: mocks.handleEmbeddingsCore,
}));
vi.mock("../../open-sse/utils/error.js", () => ({
  errorResponse: (status, message) => Response.json({ error: message }, { status }),
  unavailableResponse: (status, message) => Response.json({ error: message }, { status }),
}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), maskKey: vi.fn(),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: async (_provider, credentials) => credentials,
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));

import { handleEmbeddings } from "../../src/sse/handlers/embeddings.js";

describe("embedding usage persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveRequestUsage.mockResolvedValue(undefined);
    mocks.getProviderCredentials.mockResolvedValue({
      apiKey: "provider-secret",
      connectionId: "connection-a",
      connectionName: "Provider A",
    });
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "text-embedding-3-small" });
    mocks.getKiroAccountBudgets.mockResolvedValue(new Map());
    mocks.getAllKiroAccountUsage.mockResolvedValue(new Map());
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getKiroCreditRate.mockResolvedValue(0);
    mocks.handleEmbeddingsCore.mockResolvedValue({
      success: true,
      usage: { prompt_tokens: 12, total_tokens: 12 },
      response: Response.json({ data: [] }),
    });
  });

  it("records exact provider usage for successful embedding requests", async () => {
    await handleEmbeddings(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello" }),
    }));

    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai",
      model: "text-embedding-3-small",
      connectionId: "connection-a",
      apiKeyId: "client-id",
      endpoint: "/v1/embeddings",
      status: "success",
      tokens: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 },
    }));
  });

  it("passes exhausted Kiro accounts to the embedding fallback exclusion set", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "kiro", model: "claude-haiku" });
    mocks.getProviderConnections.mockResolvedValue([
      { id: "connection-a" },
      { id: "connection-b" },
    ]);
    mocks.getKiroAccountBudgets.mockResolvedValue(new Map([
      ["connection-a", 1],
      ["connection-b", 10],
    ]));
    mocks.getAllKiroAccountUsage.mockResolvedValue(new Map([
      ["connection-a", 2],
      ["connection-b", 0],
    ]));
    mocks.getKiroCreditRate.mockResolvedValue(1);
    mocks.getProviderCredentials.mockResolvedValue({
      apiKey: "provider-secret",
      connectionId: "connection-b",
      connectionName: "Provider B",
    });

    await handleEmbeddings(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      body: JSON.stringify({ model: "kiro/claude-haiku", input: "hello" }),
    }));

    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "kiro",
      new Set(["connection-a"]),
      "claude-haiku",
    );
  });

  it.each([
    null,
    {},
    { prompt_tokens: 0, total_tokens: 0 },
    { prompt_tokens: "12", total_tokens: 12 },
    { prompt_tokens: 12, total_tokens: 13 },
    { prompt_tokens: 12, completion_tokens: 1, total_tokens: 12 },
    { prompt_tokens: 12, total_tokens: 12, estimated: true },
  ])("does not record inexact usage %#", async (usage) => {
    mocks.handleEmbeddingsCore.mockResolvedValue({
      success: true,
      usage,
      response: Response.json({ data: [] }),
    });

    await handleEmbeddings(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello" }),
    }));

    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });
});
