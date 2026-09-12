import { AI_PROVIDERS } from "@/shared/constants/providers.js";

export function parseLimit(value, field) {
  if (value === undefined) return { value };
  if (value === null || value === "") return { value: null };
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { error: `${field} must be a non-negative number` };
  }
  return { value: parsed };
}

export function canonicalizeProviderId(provider) {
  if (typeof provider !== "string") return provider;
  const trimmed = provider.trim();
  const lower = trimmed.toLowerCase();
  const builtIn = Object.values(AI_PROVIDERS).find((entry) => (
    entry.id?.toLowerCase() === lower
    || entry.alias?.toLowerCase() === lower
    || entry.aliases?.some((alias) => alias.toLowerCase() === lower)
  ));
  return builtIn?.id || trimmed;
}

export function parseProviderBudgets(value) {
  if (value === undefined) return { value: undefined };
  if (value === null || value === "") return { value: null };
  if (!Array.isArray(value)) return { error: "providerBudgets must be an array" };

  const seen = new Set();
  const budgets = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return { error: "providerBudgets entries must be objects" };
    }
    if (typeof row.provider !== "string" || !row.provider.trim()) {
      return { error: "provider is required for provider budgets" };
    }

    const provider = canonicalizeProviderId(row.provider);
    if (seen.has(provider)) return { error: `Duplicate provider budget: ${provider}` };
    seen.add(provider);

    const input = parseLimit(row.inputTokensMonthly, "inputTokensMonthly");
    if (input.error) return input;
    const output = parseLimit(row.outputTokensMonthly, "outputTokensMonthly");
    if (output.error) return output;
    const credits = parseLimit(row.creditsMonthly, "creditsMonthly");
    if (credits.error) return credits;
    if (credits.value != null && provider !== "kiro") {
      return { error: "creditsMonthly is only supported for kiro" };
    }

    const normalized = {
      provider,
      inputTokensMonthly: input.value ?? null,
      outputTokensMonthly: output.value ?? null,
      creditsMonthly: credits.value ?? null,
    };
    if (
      normalized.inputTokensMonthly != null
      || normalized.outputTokensMonthly != null
      || normalized.creditsMonthly != null
    ) {
      budgets.push(normalized);
    }
  }

  return { value: budgets.length > 0 ? budgets : null };
}

export function parseLimits(body, fields = ["inputTokensMonthly", "outputTokensMonthly", "creditsMonthly"]) {
  const limits = {};
  for (const field of fields) {
    const result = parseLimit(body[field], field);
    if (result.error) return result;
    if (result.value !== undefined) limits[field] = result.value;
  }
  if (Object.prototype.hasOwnProperty.call(body, "providerBudgets")) {
    const providerResult = parseProviderBudgets(body.providerBudgets);
    if (providerResult.error) return providerResult;
    limits.providerBudgets = providerResult.value;
  }
  return { limits };
}
