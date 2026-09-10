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

function finiteLimit(value) {
  if (value == null) return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : NaN;
}

export async function resolveBudgetContext({ apiKey, provider, model, body }) {
  if (provider !== "kiro" || !apiKey) return null;

  const policy = await getApiKeyPolicyByKey(apiKey);
  if (!policy) return null;

  const inputLimit = finiteLimit(policy.inputTokensMonthly);
  const outputLimit = finiteLimit(policy.outputTokensMonthly);
  const creditsLimit = finiteLimit(policy.creditsMonthly);
  const limited = inputLimit !== null || outputLimit !== null || creditsLimit !== null;
  if (!limited) return null;
  if ([inputLimit, outputLimit, creditsLimit].some((limit) => Number.isNaN(limit))) {
    return {
      remainingOutputTokens: null,
      reject: quotaExceededResponse("Invalid budget configuration for this API key"),
    };
  }

  const usage = await getApiKeyUsage(apiKey, monthKey());
  const remainingInput = inputLimit === null ? Infinity : inputLimit - usage.inputTokens;
  const remainingOutput = outputLimit === null ? Infinity : outputLimit - usage.outputTokens;
  const remainingCredits = creditsLimit === null ? Infinity : creditsLimit - usage.credits;

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
