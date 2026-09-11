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
  logWarn: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getApiKeyPolicyByKey: vi.fn(),
  getApiKeyUsage: vi.fn(),
  getKiroCreditRate: vi.fn(),
  getTeamBudgetPolicy: vi.fn(),
  getTeamUsage: vi.fn(),
  getKiroAccountBudgets: vi.fn(),
  getAllKiroAccountUsage: vi.fn(),
  getProviderConnections: vi.fn(),
  monthKey: vi.fn(() => "2026-09"),
}));
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
  warn: mocks.logWarn,
  info: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn(() => "masked"),
}));
// Only the admission decisions are stubbed; the response helpers stay real so the
// assertions below pin the wire contract, not a mock's copy of it.
vi.mock("@/sse/limits/kiroBudget.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveBudgetContext: mocks.resolveBudgetContext,
  resolveAccountOutputCap: mocks.resolveAccountOutputCap,
}));

import { handleChat } from "@/sse/handlers/chat.js";

const ACCOUNT_A = { connectionId: "conn-a", connectionName: "A" };
const ACCOUNT_B = { connectionId: "conn-b", connectionName: "B" };

function kiroRequest() {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku", messages: [{ role: "user", content: "hello" }] }),
  });
}

function budgetWithAccountCeiling() {
  return {
    reject: null,
    outputCap: null,
    excludeConnectionIds: [],
    accountRemaining: new Map([["conn-a", 1]]),
    remainingCredits: 1,
    rate: 1,
    inputEstimate: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ requireApiKey: false });
  mocks.getModelInfo.mockResolvedValue({ provider: "kiro", model: "claude-haiku" });
  mocks.getComboModels.mockResolvedValue(null);
  mocks.resolveBudgetContext.mockResolvedValue(budgetWithAccountCeiling());
  mocks.resolveAccountOutputCap.mockReturnValue({ skip: false, cap: null });
  mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
  mocks.handleChatCore.mockResolvedValue({ success: false, status: 503, error: "upstream unavailable" });
});

describe("Kiro account budget fallback", () => {
  it("returns insufficient_quota when every active account is skipped for output capacity", async () => {
    mocks.resolveAccountOutputCap.mockReturnValue({ skip: true, cap: null });
    mocks.getProviderCredentials
      .mockResolvedValueOnce(ACCOUNT_A)
      .mockResolvedValueOnce(null);

    const response = await handleChat(kiroRequest());

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "No Kiro account can fit the request within its credit budget",
        type: "insufficient_quota",
        code: "insufficient_quota",
        param: null,
      },
    });
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
    // The skipped account is excluded from the next credential lookup, so the loop terminates.
    expect(mocks.getProviderCredentials.mock.calls[1][1]).toEqual(new Set(["conn-a"]));
    expect(mocks.logWarn).toHaveBeenCalledWith("LIMIT", expect.stringContaining("kiro/claude-haiku"));
  });

  it("surfaces the upstream failure when a skip is followed by a real attempt", async () => {
    mocks.resolveAccountOutputCap.mockImplementation((_budget, connectionId) =>
      connectionId === "conn-a" ? { skip: true, cap: null } : { skip: false, cap: null });
    mocks.getProviderCredentials
      .mockResolvedValueOnce(ACCOUNT_A)
      .mockResolvedValueOnce(ACCOUNT_B)
      .mockResolvedValueOnce(null);

    const response = await handleChat(kiroRequest());

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toBe("upstream unavailable");
    expect(body.error.type).not.toBe("insufficient_quota");
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore.mock.calls[0][0].connectionId).toBe("conn-b");
  });

  it("keeps the rate-limited 503 with Retry-After when the remaining accounts are cooling down", async () => {
    mocks.resolveAccountOutputCap.mockReturnValue({ skip: true, cap: null });
    mocks.getProviderCredentials
      .mockResolvedValueOnce(ACCOUNT_A)
      .mockResolvedValueOnce({
        allRateLimited: true,
        lastError: "cooldown",
        retryAfter: new Date(Date.now() + 30_000).toISOString(),
        retryAfterHuman: "30s",
      });

    const response = await handleChat(kiroRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    await expect(response.json()).resolves.toEqual({ error: { message: "[kiro/claude-haiku] cooldown (30s)" } });
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("still reports missing credentials as 404 when no budget is configured", async () => {
    mocks.resolveBudgetContext.mockResolvedValue(null);
    mocks.getProviderCredentials.mockResolvedValueOnce(null);

    const response = await handleChat(kiroRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "No active credentials for provider: kiro" },
    });
    expect(mocks.resolveAccountOutputCap).not.toHaveBeenCalled();
  });
});
