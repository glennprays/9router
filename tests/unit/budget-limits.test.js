import { describe, expect, it } from "vitest";

import { parseLimit, parseLimits, parseProviderBudgets } from "../../src/lib/http/budgetLimits.js";

describe("parseLimit", () => {
  it.each([
    [undefined, "inputTokensMonthly", { value: undefined }],
    [null, "creditsMonthly", { value: null }],
    ["", "creditsMonthly", { value: null }],
    ["12.5", "creditsMonthly", { value: 12.5 }],
    [12, "inputTokensMonthly", { value: 12 }],
  ])("parses %j as expected", (value, field, expected) => {
    expect(parseLimit(value, field)).toEqual(expected);
  });

  it.each([
    [-1, "creditsMonthly"],
    ["-0.01", "creditsMonthly"],
    ["not-a-number", "inputTokensMonthly"],
    [Infinity, "outputTokensMonthly"],
    [NaN, "outputTokensMonthly"],
  ])("rejects invalid %j", (value, field) => {
    expect(parseLimit(value, field)).toEqual({
      error: `${field} must be a non-negative number`,
    });
  });
});

describe("parseLimits", () => {
  it("returns only defined values while preserving zero and null", () => {
    expect(parseLimits({
      inputTokensMonthly: 0,
      outputTokensMonthly: undefined,
      creditsMonthly: null,
    })).toEqual({ limits: { inputTokensMonthly: 0, creditsMonthly: null } });
  });

  it("coerces a numeric-string zero", () => {
    expect(parseLimits({ creditsMonthly: "0" })).toEqual({
      limits: { creditsMonthly: 0 },
    });
  });

  it("returns empty limits when no fields are provided", () => {
    expect(parseLimits({})).toEqual({ limits: {} });
  });

  it("reports an error from a later field after valid fields", () => {
    expect(parseLimits({ inputTokensMonthly: 5, creditsMonthly: -1 })).toEqual({
      error: "creditsMonthly must be a non-negative number",
    });
  });

  it("supports custom fields and returns the first error", () => {
    expect(parseLimits({ first: "bad", second: -1 }, ["first", "second"])).toEqual({
      error: "first must be a non-negative number",
    });
  });
});

describe("parseProviderBudgets", () => {
  it("canonicalizes built-in aliases and preserves provider-node ids", () => {
    expect(parseProviderBudgets([
      { provider: "ag", inputTokensMonthly: "10", outputTokensMonthly: "", creditsMonthly: null },
      { provider: "my-node", inputTokensMonthly: 5 },
    ])).toEqual({
      value: [
        { provider: "antigravity", inputTokensMonthly: 10, outputTokensMonthly: null, creditsMonthly: null },
        { provider: "my-node", inputTokensMonthly: 5, outputTokensMonthly: null, creditsMonthly: null },
      ],
    });
  });

  it("removes rows with no configured limit and normalizes an empty array to null", () => {
    expect(parseProviderBudgets([{ provider: "openai" }])).toEqual({ value: null });
    expect(parseProviderBudgets([])).toEqual({ value: null });
  });

  it("rejects duplicates, invalid values, and non-Kiro credits", () => {
    expect(parseProviderBudgets([
      { provider: "ag", inputTokensMonthly: 1 },
      { provider: "antigravity", outputTokensMonthly: 2 },
    ])).toEqual({ error: "Duplicate provider budget: antigravity" });
    expect(parseProviderBudgets([
      { provider: "openai", inputTokensMonthly: Infinity },
    ])).toEqual({ error: "inputTokensMonthly must be a non-negative number" });
    expect(parseProviderBudgets([
      { provider: "openai", creditsMonthly: 1 },
    ])).toEqual({ error: "creditsMonthly is only supported for kiro" });
  });

  it("parses providerBudgets only when present on the parent payload", () => {
    expect(parseLimits({ inputTokensMonthly: 10 })).toEqual({
      limits: { inputTokensMonthly: 10 },
    });
    expect(parseLimits({
      providerBudgets: [{ provider: "kiro", creditsMonthly: 1 }],
    })).toEqual({
      limits: {
        providerBudgets: [
          { provider: "kiro", inputTokensMonthly: null, outputTokensMonthly: null, creditsMonthly: 1 },
        ],
      },
    });
  });
});
