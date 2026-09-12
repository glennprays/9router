import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  apiKey: null,
  policy: null,
  usage: null,
  providerBudgets: [],
}));
const mocks = vi.hoisted(() => ({
  extractApiKey: vi.fn(() => state.apiKey),
  getApiKeyPolicyByKey: vi.fn(async () => state.policy),
  getApiKeyUsage: vi.fn(async () => state.usage),
  getApiKeyProviderBudgets: vi.fn(async () => state.providerBudgets),
  monthKey: vi.fn(() => "2026-09"),
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeyPolicyByKey: mocks.getApiKeyPolicyByKey,
  getApiKeyUsage: mocks.getApiKeyUsage,
  getApiKeyProviderBudgets: mocks.getApiKeyProviderBudgets,
  monthKey: mocks.monthKey,
}));
vi.mock("@/sse/services/auth.js", () => ({ extractApiKey: mocks.extractApiKey }));
vi.mock("open-sse/utils/error.js", () => ({
  errorResponse: (status, message) => Response.json({ error: { message } }, { status }),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  AI_PROVIDERS: {
    antigravity: { id: "antigravity", alias: "ag" },
    kiro: { id: "kiro", alias: "kr" },
  },
}));

const usageRoute = await import("../../src/app/api/v1/usage/route.js");
const quotaRoute = await import("../../src/app/api/v1/quota/route.js");

beforeEach(() => {
  vi.clearAllMocks();
  state.apiKey = null;
  state.policy = null;
  state.usage = { inputTokens: 0, outputTokens: 0, credits: 0 };
  state.providerBudgets = [];
});

describe("caller quota endpoints", () => {
  it("requires a key even when the gateway allows local no-key traffic", async () => {
    const response = await usageRoute.GET(new Request("http://localhost/v1/usage"));
    expect(response.status).toBe(401);
    expect(mocks.getApiKeyPolicyByKey).not.toHaveBeenCalled();
  });

  it("rejects an inactive or unknown key", async () => {
    state.apiKey = "sk-old";
    state.policy = { id: "key-1", isActive: false };
    const response = await quotaRoute.GET(new Request("http://localhost/v1/quota"));
    expect(response.status).toBe(401);
  });

  it("returns only the caller global/provider union with clamped metric remaining", async () => {
    state.apiKey = "sk-live";
    state.policy = {
      id: "key-1", isActive: true,
      inputTokensMonthly: 100, outputTokensMonthly: 50, creditsMonthly: 2,
      teamSecret: "must-not-leak",
    };
    state.usage = { inputTokens: 120, outputTokens: 10, credits: 3 };
    state.providerBudgets = [
      {
        provider: "openai",
        inputTokensMonthly: 20,
        outputTokensMonthly: null,
        creditsMonthly: null,
        usage: { inputTokens: 25, outputTokens: 4, credits: 99 },
      },
      {
        provider: "kiro",
        inputTokensMonthly: null,
        outputTokensMonthly: 100,
        creditsMonthly: 4,
        usage: { inputTokens: 3, outputTokens: 4, credits: 5 },
      },
    ];

    const response = await usageRoute.GET(new Request("http://localhost/v1/usage", {
      headers: { authorization: "Bearer sk-live" },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      object: "usage",
      period: "2026-09",
      global: {
        input_tokens: { used: 120, limit: 100, remaining: 0 },
        output_tokens: { used: 10, limit: 50, remaining: 40 },
        kiro_credits: { used: 3, limit: 2, remaining: 0 },
      },
      providers: [
        {
          provider: "openai",
          input_tokens: { used: 25, limit: 20, remaining: 0 },
          output_tokens: { used: 4, limit: null, remaining: null },
        },
        {
          provider: "kiro",
          input_tokens: { used: 3, limit: null, remaining: null },
          output_tokens: { used: 4, limit: 100, remaining: 96 },
          kiro_credits: { used: 5, limit: 4, remaining: 0 },
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("sk-live");
    expect(JSON.stringify(body)).not.toContain("key-1");
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });
});
