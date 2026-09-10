import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  setKiroAccountBudget: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  setKiroAccountBudget: mocks.setKiroAccountBudget,
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

// resolveProviderId is intentionally NOT mocked: the route must accept both the
// canonical id ("kiro") and the registry alias ("kr") on stored connections.
const { PUT } = await import("../../src/app/api/kiro/accounts/[connectionId]/budget/route.js");

function conn(overrides) {
  return {
    id: "connA",
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

function put(connectionId, body) {
  const request = new Request(`http://localhost/api/kiro/accounts/${connectionId}/budget`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return PUT(request, { params: Promise.resolve({ connectionId }) });
}

async function responseJson(response) {
  return { status: response.status, body: await response.json() };
}

describe("PUT /api/kiro/accounts/[connectionId]/budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnectionById.mockResolvedValue(conn());
    mocks.setKiroAccountBudget.mockResolvedValue(undefined);
  });

  it("sets a numeric monthly credit ceiling on a kiro connection", async () => {
    const result = await responseJson(await put("connA", { creditsMonthly: 2000 }));

    expect(result).toEqual({ status: 200, body: { connectionId: "connA", creditsMonthly: 2000 } });
    expect(mocks.getProviderConnectionById).toHaveBeenCalledWith("connA");
    expect(mocks.setKiroAccountBudget).toHaveBeenCalledTimes(1);
    expect(mocks.setKiroAccountBudget).toHaveBeenCalledWith("connA", 2000);
  });

  it("coerces a numeric string to a number", async () => {
    const result = await responseJson(await put("connA", { creditsMonthly: "1500.5" }));

    expect(result).toEqual({ status: 200, body: { connectionId: "connA", creditsMonthly: 1500.5 } });
    expect(mocks.setKiroAccountBudget).toHaveBeenCalledWith("connA", 1500.5);
  });

  it("accepts zero as a hard ceiling", async () => {
    const result = await responseJson(await put("connA", { creditsMonthly: 0 }));

    expect(result).toEqual({ status: 200, body: { connectionId: "connA", creditsMonthly: 0 } });
    expect(mocks.setKiroAccountBudget).toHaveBeenCalledWith("connA", 0);
  });

  it("clears the ceiling when creditsMonthly is null", async () => {
    const result = await responseJson(await put("connA", { creditsMonthly: null }));

    expect(result).toEqual({ status: 200, body: { connectionId: "connA", creditsMonthly: null } });
    expect(mocks.setKiroAccountBudget).toHaveBeenCalledWith("connA", null);
  });

  it("treats an empty string as unlimited (clears the ceiling)", async () => {
    const result = await responseJson(await put("connA", { creditsMonthly: "" }));

    expect(result).toEqual({ status: 200, body: { connectionId: "connA", creditsMonthly: null } });
    expect(mocks.setKiroAccountBudget).toHaveBeenCalledWith("connA", null);
  });

  it("accepts a connection stored under the kiro registry alias", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(conn({ id: "connKr", provider: "kr" }));

    const result = await responseJson(await put("connKr", { creditsMonthly: 10 }));

    expect(result).toEqual({ status: 200, body: { connectionId: "connKr", creditsMonthly: 10 } });
    expect(mocks.setKiroAccountBudget).toHaveBeenCalledWith("connKr", 10);
  });

  it("returns 400 with the parser error for a negative value and does not mutate", async () => {
    const result = await responseJson(await put("connA", { creditsMonthly: -1 }));

    expect(result).toEqual({ status: 400, body: { error: "creditsMonthly must be a non-negative number" } });
    expect(mocks.setKiroAccountBudget).not.toHaveBeenCalled();
  });

  it("returns 400 with the parser error for a non-numeric string and does not mutate", async () => {
    const result = await responseJson(await put("connA", { creditsMonthly: "lots" }));

    expect(result).toEqual({ status: 400, body: { error: "creditsMonthly must be a non-negative number" } });
    expect(mocks.setKiroAccountBudget).not.toHaveBeenCalled();
  });

  it("returns 400 when creditsMonthly is omitted and does not mutate", async () => {
    const result = await responseJson(await put("connA", {}));

    expect(result).toEqual({ status: 400, body: { error: "creditsMonthly is required" } });
    expect(mocks.setKiroAccountBudget).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown connection before parsing or mutating", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(null);

    const result = await responseJson(await put("missing", { creditsMonthly: 5 }));

    expect(result).toEqual({ status: 404, body: { error: "Kiro account not found" } });
    expect(mocks.setKiroAccountBudget).not.toHaveBeenCalled();
  });

  it("returns 404 for a non-kiro connection and does not mutate", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(conn({ id: "connClaude", provider: "claude" }));

    const result = await responseJson(await put("connClaude", { creditsMonthly: 5 }));

    expect(result).toEqual({ status: 404, body: { error: "Kiro account not found" } });
    expect(mocks.setKiroAccountBudget).not.toHaveBeenCalled();
  });

  it("prefers 404 over 400 when the connection is unknown and the body is invalid", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(null);

    const result = await responseJson(await put("missing", {}));

    expect(result).toEqual({ status: 404, body: { error: "Kiro account not found" } });
    expect(mocks.setKiroAccountBudget).not.toHaveBeenCalled();
  });

  it("never echoes connection credentials in any response", async () => {
    const success = await responseJson(await put("connA", { creditsMonthly: 1 }));
    mocks.getProviderConnectionById.mockResolvedValue(conn({ provider: "claude" }));
    const notFound = await responseJson(await put("connA", { creditsMonthly: 1 }));

    for (const { body } of [success, notFound]) {
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("secret");
      expect(Object.keys(body).sort()).toEqual(
        body.error ? ["error"] : ["connectionId", "creditsMonthly"],
      );
    }
  });

  it("returns 500 with a generic error when the write fails", async () => {
    mocks.setKiroAccountBudget.mockRejectedValue(new Error("disk full at /Users/x/.9router/db.sqlite"));

    const result = await responseJson(await put("connA", { creditsMonthly: 5 }));

    expect(result).toEqual({ status: 500, body: { error: "Failed to update Kiro account budget" } });
  });
});
