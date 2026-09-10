import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  resetKiroAccountUsageByConnectionId: vi.fn(),
  resetTeamUsage: vi.fn(),
  resetApiKeyUsageByKey: vi.fn(),
  resetApiKeyUsageById: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  resetKiroAccountUsageByConnectionId: mocks.resetKiroAccountUsageByConnectionId,
  resetTeamUsage: mocks.resetTeamUsage,
  resetApiKeyUsageByKey: mocks.resetApiKeyUsageByKey,
  resetApiKeyUsageById: mocks.resetApiKeyUsageById,
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
const { POST } = await import("../../src/app/api/kiro/accounts/[connectionId]/reset-usage/route.js");

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

function post(connectionId) {
  const request = new Request(`http://localhost/api/kiro/accounts/${connectionId}/reset-usage`, {
    method: "POST",
  });
  return POST(request, { params: Promise.resolve({ connectionId }) });
}

async function responseJson(response) {
  return { status: response.status, body: await response.json() };
}

function expectNoOtherScopeTouched() {
  expect(mocks.resetTeamUsage).not.toHaveBeenCalled();
  expect(mocks.resetApiKeyUsageByKey).not.toHaveBeenCalled();
  expect(mocks.resetApiKeyUsageById).not.toHaveBeenCalled();
}

describe("POST /api/kiro/accounts/[connectionId]/reset-usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnectionById.mockResolvedValue(conn());
    mocks.resetKiroAccountUsageByConnectionId.mockResolvedValue(true);
  });

  it("resets only the selected kiro account's usage", async () => {
    const result = await responseJson(await post("connA"));

    expect(result).toEqual({ status: 200, body: { message: "Account usage reset" } });
    expect(mocks.getProviderConnectionById).toHaveBeenCalledWith("connA");
    expect(mocks.resetKiroAccountUsageByConnectionId).toHaveBeenCalledTimes(1);
    expect(mocks.resetKiroAccountUsageByConnectionId).toHaveBeenCalledWith("connA");
    expectNoOtherScopeTouched();
  });

  it("accepts a connection stored under the kiro registry alias", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(conn({ id: "connKr", provider: "kr" }));

    const result = await responseJson(await post("connKr"));

    expect(result).toEqual({ status: 200, body: { message: "Account usage reset" } });
    expect(mocks.resetKiroAccountUsageByConnectionId).toHaveBeenCalledWith("connKr");
  });

  it("returns 404 for an unknown connection and does not reset anything", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(null);

    const result = await responseJson(await post("missing"));

    expect(result).toEqual({ status: 404, body: { error: "Kiro account not found" } });
    expect(mocks.resetKiroAccountUsageByConnectionId).not.toHaveBeenCalled();
    expectNoOtherScopeTouched();
  });

  it("returns 404 for a non-kiro connection and does not reset anything", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(conn({ id: "connClaude", provider: "claude" }));

    const result = await responseJson(await post("connClaude"));

    expect(result).toEqual({ status: 404, body: { error: "Kiro account not found" } });
    expect(mocks.resetKiroAccountUsageByConnectionId).not.toHaveBeenCalled();
    expectNoOtherScopeTouched();
  });

  it("never echoes connection credentials in any response", async () => {
    const success = await responseJson(await post("connA"));
    mocks.getProviderConnectionById.mockResolvedValue(conn({ provider: "claude" }));
    const notFound = await responseJson(await post("connA"));

    for (const { body } of [success, notFound]) {
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("secret");
      expect(Object.keys(body)).toEqual(body.error ? ["error"] : ["message"]);
    }
  });

  it("returns 500 with a generic error when the lookup fails", async () => {
    mocks.getProviderConnectionById.mockRejectedValue(new Error("db locked at /Users/x/.9router/db.sqlite"));

    const result = await responseJson(await post("connA"));

    expect(result).toEqual({ status: 500, body: { error: "Failed to reset usage" } });
    expect(mocks.resetKiroAccountUsageByConnectionId).not.toHaveBeenCalled();
  });

  it("returns 500 with a generic error when the reset fails", async () => {
    mocks.resetKiroAccountUsageByConnectionId.mockRejectedValue(
      new Error("disk full at /Users/x/.9router/db.sqlite"),
    );

    const result = await responseJson(await post("connA"));

    expect(result).toEqual({ status: 500, body: { error: "Failed to reset usage" } });
  });
});
