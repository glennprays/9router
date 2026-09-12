import { getApiKeyPolicyByKey, getApiKeyUsage, getApiKeyProviderBudgets, monthKey } from "@/lib/localDb";
import { extractApiKey } from "@/sse/services/auth.js";
import { errorResponse } from "open-sse/utils/error.js";
import { canonicalizeProviderId } from "@/lib/http/budgetLimits.js";

export const dynamic = "force-dynamic";

function active(policy) {
  return policy && (policy.isActive === true || policy.isActive === 1);
}

function metric(limitValue, usedValue) {
  const used = Number.isFinite(Number(usedValue)) ? Number(usedValue) : 0;
  if (limitValue == null) return { used, limit: null, remaining: null };
  const limit = Number(limitValue);
  if (!Number.isFinite(limit) || limit < 0) return { used, limit: null, remaining: null };
  return { used, limit, remaining: Math.max(0, limit - used) };
}

export async function GET(request) {
  const apiKey = extractApiKey(request);
  if (!apiKey) return errorResponse(401, "Missing API key");

  const policy = await getApiKeyPolicyByKey(apiKey);
  if (!active(policy)) return errorResponse(401, "Invalid API key");

  const period = monthKey();
  const [usage, providerBudgets] = await Promise.all([
    getApiKeyUsage(policy.id, period),
    getApiKeyProviderBudgets(policy.id, period),
  ]);

  return Response.json({
    object: "usage",
    period,
    global: {
      input_tokens: metric(policy.inputTokensMonthly, usage?.inputTokens),
      output_tokens: metric(policy.outputTokensMonthly, usage?.outputTokens),
      kiro_credits: metric(policy.creditsMonthly, usage?.credits),
    },
    providers: providerBudgets.map((row) => {
      const provider = canonicalizeProviderId(row.provider) || row.provider;
      const result = {
        provider,
        input_tokens: metric(row.inputTokensMonthly, row.usage?.inputTokens),
        output_tokens: metric(row.outputTokensMonthly, row.usage?.outputTokens),
      };
      if (provider === "kiro") {
        result.kiro_credits = metric(row.creditsMonthly, row.usage?.credits);
      }
      return result;
    }),
  });
}
