import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  handleChatCore: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
  resolveBudgetContext: vi.fn(),
  resolveAccountOutputCap: vi.fn(),
  clampOutputTokens: vi.fn((body) => body),
  quotaExceededResponse: vi.fn((message) => new Response(JSON.stringify({
    error: { message, type: "insufficient_quota", code: "insufficient_quota", param: null },
  }), { status: 429, headers: { "Content-Type": "application/json" } })),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: mocks.updateProviderCredentials,
}));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
  detectRequiredCapabilities: vi.fn(() => new Set()),
}));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: vi.fn((handler) => handler),
  getActiveAdapterStrategy: vi.fn(),
}));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("open-sse/translator/formats.js", () => ({ detectFormatByEndpoint: vi.fn() }));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn(() => "masked"),
}));
vi.mock("@/sse/limits/kiroBudget.js", () => ({
  resolveBudgetContext: mocks.resolveBudgetContext,
  resolveAccountOutputCap: mocks.resolveAccountOutputCap,
  clampOutputTokens: mocks.clampOutputTokens,
  quotaExceededResponse: mocks.quotaExceededResponse,
}));

import { handleChat } from "@/sse/handlers/chat.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ requireApiKey: false });
  mocks.getModelInfo.mockResolvedValue({ provider: "kiro", model: "claude-haiku" });
  mocks.getComboModels.mockResolvedValue(null);
  mocks.resolveBudgetContext.mockResolvedValue({
    reject: null,
    outputCap: null,
    excludeConnectionIds: [],
    accountRemaining: new Map([["conn-a", 1]]),
    remainingCredits: 1,
    rate: 1,
    inputEstimate: 1,
  });
  mocks.resolveAccountOutputCap.mockReturnValue({ skip: true, cap: null });
  mocks.getProviderCredentials
    .mockResolvedValueOnce({ connectionId: "conn-a", connectionName: "A" })
    .mockResolvedValueOnce(null);
  mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
  mocks.handleChatCore.mockResolvedValue({ success: false, status: 503, error: "upstream unavailable" });
});

describe("Kiro account budget fallback", () => {
  it("returns insufficient_quota when every active account is skipped for output capacity", async () => {
    const response = await handleChat(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku", messages: [{ role: "user", content: "hello" }] }),
    }));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "insufficient_quota", code: "insufficient_quota" },
    });
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });
});
