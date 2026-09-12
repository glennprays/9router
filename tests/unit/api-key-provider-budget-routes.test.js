import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiKeysWithUsage: vi.fn(),
  createApiKey: vi.fn(),
  getApiKeyById: vi.fn(),
  updateApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  getProviderConnections: vi.fn(),
  getProviderNodes: vi.fn(),
  getApiKeyProviderBudgets: vi.fn(),
  getApiKeyProviderUsage: vi.fn(),
  resetApiKeyUsageById: vi.fn(),
  resetApiKeyProviderUsage: vi.fn(),
  getConsistentMachineId: vi.fn(async () => "machine-1"),
  getRoutableProviders: vi.fn(),
  validateRoutableProviderBudgets: vi.fn(),
  monthKey: vi.fn(() => "2026-09"),
}));
vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  },
}));

vi.mock("@/shared/utils/machineId.js", () => ({ getConsistentMachineId: mocks.getConsistentMachineId }));
vi.mock("@/shared/constants/providers.js", () => ({
  AI_PROVIDERS: {
    openai: { id: "openai", name: "OpenAI", alias: "openai", noAuth: false },
    antigravity: { id: "antigravity", name: "Antigravity", alias: "ag", noAuth: false },
    "free-provider": { id: "free-provider", name: "Free Provider", alias: "free", noAuth: true },
  },
}));
vi.mock("@/lib/localDb", () => mocks);
vi.mock("@/lib/http/providerRoutability.js", () => ({
  getRoutableProviders: mocks.getRoutableProviders,
  validateRoutableProviderBudgets: mocks.validateRoutableProviderBudgets,
}));

const keysRoute = await import("../../src/app/api/keys/route.js");
const keyRoute = await import("../../src/app/api/keys/[id]/route.js");
const resetRoute = await import("../../src/app/api/keys/[id]/reset-usage/route.js");
const providerResetRoute = await import("../../src/app/api/keys/[id]/providers/[provider]/reset-usage/route.js");

function requestWithBody(url, body, method = "POST") {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function jsonResponse(response) {
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  mocks.getConsistentMachineId.mockResolvedValue("machine-1");
  mocks.getRoutableProviders.mockResolvedValue([
    { id: "openai", name: "OpenAI" },
    { id: "antigravity", name: "Antigravity" },
    { id: "custom-node", name: "Custom node" },
    { id: "free-provider", name: "Free Provider" },
  ]);
  mocks.validateRoutableProviderBudgets.mockImplementation(async (budgets) => {
    if (budgets?.some((budget) => budget.provider === "missing")) {
      throw new Error("Provider is not currently routable: missing");
    }
    return budgets;
  });
  mocks.getApiKeysWithUsage.mockResolvedValue([]);
  mocks.getApiKeyProviderBudgets.mockResolvedValue([]);
  mocks.getApiKeyProviderUsage.mockResolvedValue([]);
  mocks.createApiKey.mockResolvedValue({
    id: "key-1", key: "sk-new", name: "new", machineId: "machine-1",
    inputTokensMonthly: null, outputTokensMonthly: null, creditsMonthly: null,
  });
  mocks.updateApiKey.mockResolvedValue({ id: "key-1", name: "updated" });
  mocks.getApiKeyById.mockResolvedValue({ id: "key-1", isActive: true });
});

describe("provider budget validation and key routes", () => {
  it("rejects a newly-created policy for an unroutable provider", async () => {
    const result = await jsonResponse(await keysRoute.POST(requestWithBody("/api/keys", {
      name: "new", providerBudgets: [{ provider: "missing", inputTokensMonthly: 10 }],
    })));

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/routable/i);
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });

  it("creates the key and provider policies through one repository call", async () => {
    const result = await jsonResponse(await keysRoute.POST(requestWithBody("/api/keys", {
      name: "new", providerBudgets: [
        { provider: "ag", outputTokensMonthly: 20 },
        { provider: "custom-node", inputTokensMonthly: 10 },
      ],
    })));
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      id: "key-1",
      key: "sk-new",
      providerBudgets: [
        { provider: "antigravity", outputTokensMonthly: 20 },
        { provider: "custom-node", inputTokensMonthly: 10 },
      ],
    });
    expect(mocks.validateRoutableProviderBudgets).toHaveBeenCalled();
    expect(mocks.getConsistentMachineId).toHaveBeenCalled();
    expect(mocks.createApiKey).toHaveBeenCalledWith("new", "machine-1", {
      providerBudgets: [
        { provider: "antigravity", inputTokensMonthly: null, outputTokensMonthly: 20, creditsMonthly: null },
        { provider: "custom-node", inputTokensMonthly: 10, outputTokensMonthly: null, creditsMonthly: null },
      ],
    });
  });

  it("returns global and provider remaining values plus routable picker rows", async () => {
    mocks.getApiKeysWithUsage.mockResolvedValue([{
      id: "key-1", name: "member", inputTokensMonthly: 100, outputTokensMonthly: 50, creditsMonthly: 3,
      usage: { periodKey: "2026-09", inputTokens: 110, outputTokens: 10, credits: 4 },
      providerBudgets: [{
        provider: "openai", inputTokensMonthly: 20, outputTokensMonthly: null, creditsMonthly: null,
        usage: { periodKey: "2026-09", inputTokens: 25, outputTokens: 1, credits: 0 },
      }],
    }]);

    const result = await jsonResponse(await keysRoute.GET());

    expect(result.status).toBe(200);
    expect(result.body.keys[0].remaining).toEqual({ inputTokens: 0, outputTokens: 40, credits: 0 });
    expect(result.body.keys[0].providerBudgets[0].remaining).toEqual({ inputTokens: 0, outputTokens: null, credits: null });
    expect(result.body.routableProviders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "openai" }),
      expect.objectContaining({ id: "custom-node" }),
      expect.objectContaining({ id: "free-provider" }),
    ]));
  });

  it("preserves stale policies on edit while allowing their removal", async () => {
    mocks.validateRoutableProviderBudgets.mockClear();
    mocks.getApiKeyById.mockResolvedValue({
      id: "key-1", isActive: true,
    });
    mocks.getApiKeyProviderBudgets.mockResolvedValue([
      { provider: "stale-provider", inputTokensMonthly: 10, usage: { inputTokens: 0, outputTokens: 0, credits: 0 } },
    ]);
    mocks.updateApiKey.mockResolvedValue({ id: "key-1" });

    const result = await jsonResponse(await keyRoute.PUT(
      requestWithBody("/api/keys/key-1", { providerBudgets: [] }, "PUT"),
      { params: Promise.resolve({ id: "key-1" }) },
    ));

    expect(result.status).toBe(200);
    expect(mocks.validateRoutableProviderBudgets).toHaveBeenCalledWith(null, { allow: ["stale-provider"] });
    expect(mocks.updateApiKey).toHaveBeenCalled();
  });

  it("resets a configured provider even when its current counter is empty", async () => {
    mocks.getApiKeyById.mockResolvedValue({ id: "key-1" });
    mocks.getApiKeyProviderBudgets.mockResolvedValue([
      { provider: "openai", inputTokensMonthly: 10, usage: { inputTokens: 0, outputTokens: 0, credits: 0 } },
    ]);
    mocks.resetApiKeyProviderUsage.mockResolvedValue(true);

    const result = await jsonResponse(await providerResetRoute.POST(
      new Request("http://localhost/api/keys/key-1/providers/openai/reset-usage", { method: "POST" }),
      { params: Promise.resolve({ id: "key-1", provider: "openai" }) },
    ));

    expect(result.status).toBe(200);
    expect(mocks.resetApiKeyProviderUsage).toHaveBeenCalledWith("key-1", "openai");
  });

  it("resets only the current global/provider counters and distinguishes unknown rows", async () => {
    mocks.resetApiKeyUsageById.mockResolvedValue(true);
    const globalResult = await jsonResponse(await resetRoute.POST(
      new Request("http://localhost/api/keys/key-1/reset-usage", { method: "POST" }),
      { params: Promise.resolve({ id: "key-1" }) },
    ));
    expect(globalResult.status).toBe(200);
    expect(mocks.resetApiKeyUsageById).toHaveBeenCalledWith("key-1");

    mocks.getApiKeyById.mockResolvedValue({ id: "key-1" });
    mocks.getApiKeyProviderBudgets.mockResolvedValue([]);
    mocks.resetApiKeyProviderUsage.mockResolvedValue(false);
    const providerResult = await jsonResponse(await providerResetRoute.POST(
      new Request("http://localhost/api/keys/key-1/providers/openai/reset-usage", { method: "POST" }),
      { params: Promise.resolve({ id: "key-1", provider: "openai" }) },
    ));
    expect(providerResult.status).toBe(404);
  });

});
