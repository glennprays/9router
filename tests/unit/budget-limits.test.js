import { describe, expect, it } from "vitest";

import { parseLimit, parseLimits } from "../../src/lib/http/budgetLimits.js";

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

  it("supports custom fields and returns the first error", () => {
    expect(parseLimits({ first: "bad", second: -1 }, ["first", "second"])).toEqual({
      error: "first must be a non-negative number",
    });
  });
});
