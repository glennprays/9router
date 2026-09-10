import { estimateInputTokens } from "open-sse/utils/usageTracking.js";
import {
  getApiKeyPolicyByKey,
  getApiKeyUsage,
  getKiroCreditRate,
  monthKey,
} from "@/lib/localDb";

export function quotaExceededResponse(message) {
  return new Response(JSON.stringify({
    error: {
      message,
      type: "insufficient_quota",
      code: "insufficient_quota",
      param: null,
    },
  }), {
    status: 429,
    headers: { "Content-Type": "application/json" },
  });
}

export async function resolveBudgetContext({ apiKey, provider, model, body }) {
  if (provider !== "kiro" || !apiKey) return null;

  const policy = await getApiKeyPolicyByKey(apiKey);
  if (!policy) return null;

  const limited = policy.inputTokensMonthly != null
    || policy.outputTokensMonthly != null
    || policy.creditsMonthly != null;
  if (!limited) return null;

  const usage = await getApiKeyUsage(apiKey, monthKey());
  const remainingInput = policy.inputTokensMonthly == null
    ? Infinity
    : policy.inputTokensMonthly - usage.inputTokens;
  const remainingOutput = policy.outputTokensMonthly == null
    ? Infinity
    : policy.outputTokensMonthly - usage.outputTokens;
  const remainingCredits = policy.creditsMonthly == null
    ? Infinity
    : policy.creditsMonthly - usage.credits;

  if (remainingInput <= 0 || remainingOutput <= 0 || remainingCredits <= 0) {
    return {
      remainingOutputTokens: null,
      reject: quotaExceededResponse("Insufficient quota for this API key"),
    };
  }

  const inputEstimate = estimateInputTokens(body);
  if (Number.isFinite(remainingInput) && inputEstimate > remainingInput) {
    return {
      remainingOutputTokens: null,
      reject: quotaExceededResponse("Input token budget exceeded for this API key"),
    };
  }

  const rate = Number.isFinite(remainingCredits) ? await getKiroCreditRate(model) : 0;
  const creditBoundedOutput = rate > 0
    ? Math.floor(remainingCredits / rate) - inputEstimate
    : Infinity;
  if (rate > 0 && creditBoundedOutput <= 0) {
    return {
      remainingOutputTokens: null,
      reject: quotaExceededResponse("Credit budget would be exceeded for this API key"),
    };
  }

  const outputCap = Math.min(
    Number.isFinite(remainingOutput) ? remainingOutput : Infinity,
    creditBoundedOutput
  );
  return {
    remainingOutputTokens: Number.isFinite(outputCap) ? outputCap : null,
    reject: null,
  };
}
