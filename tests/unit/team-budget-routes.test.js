import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getTeamBudgetPolicy: vi.fn(),
  getTeamUsage: vi.fn(),
  setTeamBudgetPolicy: vi.fn(),
  resetTeamUsage: vi.fn(),
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

vi.mock("@/lib/localDb", () => mocks);

const budgetRoute = await import("../../src/app/api/team/budget/route.js");
const resetRoute = await import("../../src/app/api/team/budget/reset-usage/route.js");

function requestWithBody(body) {
  return new Request("http://localhost/api/team/budget", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function responseJson(response) {
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.monthKey.mockReturnValue("2026-09");
});

describe("GET /api/team/budget", () => {
  it("returns all-null policy and zero usage when no policy exists", async () => {
    mocks.getTeamBudgetPolicy.mockResolvedValue(null);
    mocks.getTeamUsage.mockResolvedValue({
      periodKey: "2026-09", inputTokens: 0, outputTokens: 0, credits: 0,
    });

    const result = await responseJson(await budgetRoute.GET());

    expect(result).toEqual({
      status: 200,
      body: {
        policy: { inputTokensMonthly: null, outputTokensMonthly: null, creditsMonthly: null },
        usage: { periodKey: "2026-09", inputTokens: 0, outputTokens: 0, credits: 0 },
        remaining: { inputTokens: null, outputTokens: null, credits: null },
      },
    });
    expect(mocks.getTeamUsage).toHaveBeenCalledWith("2026-09");
  });

  it("clamps finite remaining values at zero", async () => {
    mocks.getTeamBudgetPolicy.mockResolvedValue({
      inputTokensMonthly: 100, outputTokensMonthly: 75, creditsMonthly: 2.5,
    });
    mocks.getTeamUsage.mockResolvedValue({
      periodKey: "2026-09", inputTokens: 125, outputTokens: 25, credits: 3,
    });

    const result = await responseJson(await budgetRoute.GET());

    expect(result.body.remaining).toEqual({ inputTokens: 0, outputTokens: 50, credits: 0 });
  });
  it("returns the standard 500 response when reading fails", async () => {
    mocks.getTeamBudgetPolicy.mockRejectedValue(new Error("database unavailable"));

    const result = await responseJson(await budgetRoute.GET());

    expect(result).toEqual({
      status: 500,
      body: { error: "Failed to fetch team budget" },
    });
  });

});

describe("PUT /api/team/budget", () => {
  it("merges provided limits while preserving omitted fields and clearing null fields", async () => {
    mocks.getTeamBudgetPolicy.mockResolvedValue({
      inputTokensMonthly: 100, outputTokensMonthly: 200, creditsMonthly: 300,
    });
    mocks.setTeamBudgetPolicy.mockImplementation(async (policy) => policy);

    const result = await responseJson(await budgetRoute.PUT(requestWithBody({
      outputTokensMonthly: null, creditsMonthly: 0,
    })));

    expect(result).toEqual({
      status: 200,
      body: { policy: { inputTokensMonthly: 100, outputTokensMonthly: null, creditsMonthly: 0 } },
    });
    expect(mocks.setTeamBudgetPolicy).toHaveBeenCalledWith({
      inputTokensMonthly: 100, outputTokensMonthly: null, creditsMonthly: 0,
    });
  });

  it("returns a validation error without writing invalid limits", async () => {
    const result = await responseJson(await budgetRoute.PUT(requestWithBody({ creditsMonthly: -1 })));

    expect(result).toEqual({
      status: 400,
      body: { error: "creditsMonthly must be a non-negative number" },
    });
    expect(mocks.setTeamBudgetPolicy).not.toHaveBeenCalled();
  });
  it("returns the standard 500 response when writing fails", async () => {
    mocks.getTeamBudgetPolicy.mockResolvedValue(null);
    mocks.setTeamBudgetPolicy.mockRejectedValue(new Error("database unavailable"));

    const result = await responseJson(await budgetRoute.PUT(requestWithBody({ creditsMonthly: 1 })));

    expect(result).toEqual({
      status: 500,
      body: { error: "Failed to update team budget" },
    });
  });

});

describe("POST /api/team/budget/reset-usage", () => {
  it("resets all team usage and returns the documented message", async () => {
    const result = await responseJson(await resetRoute.POST());

    expect(result).toEqual({ status: 200, body: { message: "Team usage reset" } });
    expect(mocks.resetTeamUsage).toHaveBeenCalledOnce();
  });
  it("returns the standard 500 response when reset fails", async () => {
    mocks.resetTeamUsage.mockRejectedValue(new Error("database unavailable"));

    const result = await responseJson(await resetRoute.POST());

    expect(result).toEqual({
      status: 500,
      body: { error: "Failed to reset usage" },
    });
  });
});
