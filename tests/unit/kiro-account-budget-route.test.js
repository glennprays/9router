import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getKiroAccountBudgets: vi.fn(),
  getAllKiroAccountUsage: vi.fn(),
  monthKey: vi.fn(() => "2026-09"),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getKiroAccountBudgets: mocks.getKiroAccountBudgets,
  getAllKiroAccountUsage: mocks.getAllKiroAccountUsage,
  monthKey: mocks.monthKey,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

const SAFE_KEYS = [
  "connectionId",
  "name",
  "creditsMonthly",
  "credits",
  "remaining",
  "testStatus",
  "lastError",
].sort();

function conn(overrides) {
  return {
    provider: "kiro",
    authType: "oauth",
    isActive: true,
    accessToken: "at-secret",
    refreshToken: "rt-secret",
    idToken: "id-secret",
    apiKey: "ak-secret",
    ...overrides,
  };
}

describe("GET /api/kiro/accounts/budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.monthKey.mockReturnValue("2026-09");
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getKiroAccountBudgets.mockResolvedValue(new Map());
    mocks.getAllKiroAccountUsage.mockResolvedValue(new Map());
  });

  it("lists active kiro accounts with policy, usage, remaining and status", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      conn({ id: "connA", displayName: "Alice", name: "a", email: "a@x", testStatus: "success", lastError: null }),
      conn({ id: "connB", name: "Bob", email: "b@x", testStatus: null, lastError: "boom" }),
      conn({ id: "connC", email: "c@x" }),
      conn({ id: "connD" }),
    ]);
    mocks.getKiroAccountBudgets.mockResolvedValue(new Map([
      ["connA", 2000],
      ["connB", 100],
      ["connC", null],
    ]));
    mocks.getAllKiroAccountUsage.mockResolvedValue(new Map([
      ["connA", 500.5],
      ["connB", 150],
    ]));

    const { GET } = await import("../../src/app/api/kiro/accounts/budget/route.js");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.getProviderConnections).toHaveBeenCalledWith({ provider: "kiro", isActive: true });
    expect(mocks.getAllKiroAccountUsage).toHaveBeenCalledWith("2026-09");
    expect(body.periodKey).toBe("2026-09");
    expect(body.accounts).toEqual([
      {
        connectionId: "connA",
        name: "Alice",
        creditsMonthly: 2000,
        credits: 500.5,
        remaining: 1499.5,
        testStatus: "success",
        lastError: null,
      },
      {
        connectionId: "connB",
        name: "Bob",
        creditsMonthly: 100,
        credits: 150,
        remaining: 0,
        testStatus: null,
        lastError: "boom",
      },
      {
        connectionId: "connC",
        name: "c@x",
        creditsMonthly: null,
        credits: 0,
        remaining: null,
        testStatus: null,
        lastError: null,
      },
      {
        connectionId: "connD",
        name: "connD",
        creditsMonthly: null,
        credits: 0,
        remaining: null,
        testStatus: null,
        lastError: null,
      },
    ]);
  });

  it("emits only safe display/status fields — never tokens or credentials", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn({ id: "connA", displayName: "Alice" })]);

    const { GET } = await import("../../src/app/api/kiro/accounts/budget/route.js");
    const body = await (await GET()).json();
    const text = JSON.stringify(body);

    expect(body.accounts).toHaveLength(1);
    expect(Object.keys(body.accounts[0]).sort()).toEqual(SAFE_KEYS);
    for (const secret of ["at-secret", "rt-secret", "id-secret", "ak-secret"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("returns an empty list when there are no active kiro accounts", async () => {
    const { GET } = await import("../../src/app/api/kiro/accounts/budget/route.js");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ periodKey: "2026-09", accounts: [] });
  });

  it("returns 500 with a generic error when a repository call fails", async () => {
    mocks.getKiroAccountBudgets.mockRejectedValue(new Error("db down"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { GET } = await import("../../src/app/api/kiro/accounts/budget/route.js");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Failed to fetch Kiro account budgets" });
    logSpy.mockRestore();
  });
});
