import { estimateInputTokens } from "open-sse/utils/usageTracking.js";
import {
  getApiKeyPolicyByKey,
  getApiKeyUsage,
  getApiKeyProviderBudgets,
  getKiroCreditRate,
  getTeamBudgetPolicy,
  getTeamUsage,
  getKiroAccountBudgets,
  getAllKiroAccountUsage,
  getProviderConnections,
  monthKey,
} from "@/lib/localDb";
import { canonicalizeProviderId } from "@/lib/http/budgetLimits.js";

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

function isActivePolicy(policy) {
  return Boolean(policy) && policy.isActive !== false && policy.isActive !== 0;
}

function hasLimits(...limits) {
  return limits.some((limit) => limit !== null);
}

function remaining(limit, used) {
  return limit === null ? Infinity : limit - Number(used || 0);
}

export function clampOutputTokens(body, cap) {
  if (cap == null) return body;

  const cappedBody = {
    ...body,
    ...(body.max_tokens != null ? { max_tokens: Math.min(body.max_tokens, cap) } : {}),
    ...(body.max_completion_tokens != null
      ? { max_completion_tokens: Math.min(body.max_completion_tokens, cap) }
      : {}),
    ...(body.max_output_tokens != null
      ? { max_output_tokens: Math.min(body.max_output_tokens, cap) }
      : { max_output_tokens: cap }),
  };
  if (Array.isArray(body.contents) || body.generationConfig) {
    cappedBody.generationConfig = {
      ...(body.generationConfig || {}),
      maxOutputTokens: Math.min(Number(body.generationConfig?.maxOutputTokens ?? cap), cap),
    };
  }
  if (body.request && typeof body.request === "object"
    && (Array.isArray(body.request.contents) || body.request.generationConfig)) {
    cappedBody.request = {
      ...body.request,
      generationConfig: {
        ...(body.request.generationConfig || {}),
        maxOutputTokens: Math.min(Number(body.request.generationConfig?.maxOutputTokens ?? cap), cap),
      },
    };
  }
  return cappedBody;
}

export async function resolveBudgetContext({
  apiKey,
  apiKeyId,
  provider,
  model,
  body,
  hasOutput = true,
  memberPolicy: suppliedMemberPolicy,
}) {
  const providerId = canonicalizeProviderId(provider) || provider;
  const memberPolicy = suppliedMemberPolicy || (apiKey ? await getApiKeyPolicyByKey(apiKey) : null);
  const activeMemberPolicy = isActivePolicy(memberPolicy) ? memberPolicy : null;
  const stableApiKeyId = activeMemberPolicy ? (apiKeyId || activeMemberPolicy.id || null) : null;
  const teamPolicy = await getTeamBudgetPolicy();

  const isKiro = providerId === "kiro";
  const providerBudgets = stableApiKeyId
    ? await getApiKeyProviderBudgets(stableApiKeyId, monthKey())
    : [];
  const providerBudget = providerBudgets.find((budget) => budget.provider === providerId) || null;

  const storedBudgets = isKiro ? await getKiroAccountBudgets() : new Map();
  let conns = [];
  const accountBudgets = new Map();
  if (isKiro && storedBudgets.size > 0) {
    conns = await getProviderConnections({ provider: "kiro", isActive: true });
    for (const connection of conns) {
      if (storedBudgets.has(connection.id)) accountBudgets.set(connection.id, storedBudgets.get(connection.id));
    }
  }

  const memberInput = finiteLimit(activeMemberPolicy?.inputTokensMonthly);
  const memberOutput = finiteLimit(activeMemberPolicy?.outputTokensMonthly);
  const memberCredits = isKiro ? finiteLimit(activeMemberPolicy?.creditsMonthly) : null;
  const providerInput = finiteLimit(providerBudget?.inputTokensMonthly);
  const providerOutput = finiteLimit(providerBudget?.outputTokensMonthly);
  const providerCredits = isKiro ? finiteLimit(providerBudget?.creditsMonthly) : null;
  const teamInput = finiteLimit(teamPolicy?.inputTokensMonthly);
  const teamOutput = finiteLimit(teamPolicy?.outputTokensMonthly);
  const teamCredits = isKiro ? finiteLimit(teamPolicy?.creditsMonthly) : null;
  const accountLimitValues = [...accountBudgets.values()].map((value) => finiteLimit(value));
  const anyAccountCeiling = accountLimitValues.some((limit) => limit !== null);
  const limits = [
    memberInput, memberOutput, memberCredits,
    providerInput, providerOutput, providerCredits,
    teamInput, teamOutput, teamCredits,
  ];

  if (!hasLimits(...limits) && !anyAccountCeiling) return null;
  if (limits.some((limit) => Number.isNaN(limit)) || accountLimitValues.some((limit) => Number.isNaN(limit))) {
    return { reject: quotaExceededResponse("Invalid budget configuration") };
  }

  const period = monthKey();
  const memberLimited = hasLimits(memberInput, memberOutput, memberCredits, providerInput, providerOutput, providerCredits);
  const teamLimited = hasLimits(teamInput, teamOutput, teamCredits);
  const memberUsage = memberLimited
    ? await getApiKeyUsage(stableApiKeyId || apiKey, period)
    : { inputTokens: 0, outputTokens: 0, credits: 0 };
  const providerUsage = providerBudget?.usage || { inputTokens: 0, outputTokens: 0, credits: 0 };
  const teamUsage = teamLimited
    ? await getTeamUsage(period)
    : { inputTokens: 0, outputTokens: 0, credits: 0 };

  const remIn = Math.min(
    remaining(memberInput, memberUsage?.inputTokens),
    remaining(providerInput, providerUsage?.inputTokens),
    remaining(teamInput, teamUsage?.inputTokens),
  );
  const remOut = Math.min(
    remaining(memberOutput, memberUsage?.outputTokens),
    remaining(providerOutput, providerUsage?.outputTokens),
    remaining(teamOutput, teamUsage?.outputTokens),
  );
  const remCred = Math.min(
    remaining(memberCredits, memberUsage?.credits),
    remaining(providerCredits, providerUsage?.credits),
    remaining(teamCredits, teamUsage?.credits),
  );

  if (remIn <= 0 || (hasOutput && (remOut <= 0 || (isKiro && remCred <= 0)))) {
    return { reject: quotaExceededResponse("Insufficient quota") };
  }

  const inputEstimate = estimateInputTokens(body);
  if (Number.isFinite(remIn) && inputEstimate > remIn) {
    return { reject: quotaExceededResponse("Input token budget exceeded") };
  }

  const rate = isKiro && (Number.isFinite(remCred) || anyAccountCeiling)
    ? await getKiroCreditRate(model)
    : 0;
  const creditBoundedOutput = isKiro && hasOutput && rate > 0
    ? Math.floor(remCred / rate) - inputEstimate
    : Infinity;
  if (isKiro && hasOutput && rate > 0 && creditBoundedOutput <= 0) {
    return { reject: quotaExceededResponse("Credit budget would be exceeded") };
  }

  const outputCap = hasOutput
    ? Math.min(Number.isFinite(remOut) ? remOut : Infinity, creditBoundedOutput)
    : Infinity;
  let excludeConnectionIds = [];
  let accountRemaining = null;
  if (isKiro && anyAccountCeiling) {
    const usageMap = await getAllKiroAccountUsage(period);
    accountRemaining = new Map();
    let eligibleCount = 0;
    for (const connection of conns) {
      const ceiling = finiteLimit(accountBudgets.get(connection.id));
      if (ceiling === null) {
        eligibleCount += 1;
        continue;
      }
      const accountRemainingValue = ceiling - (usageMap.get(connection.id) || 0);
      if (accountRemainingValue <= 0) {
        excludeConnectionIds.push(connection.id);
      } else {
        eligibleCount += 1;
        accountRemaining.set(connection.id, accountRemainingValue);
      }
    }
    if (conns.length > 0 && eligibleCount === 0) {
      return { reject: quotaExceededResponse("All Kiro accounts have reached their credit limit") };
    }
  }

  return {
    reject: null,
    outputCap: Number.isFinite(outputCap) ? outputCap : null,
    remainingCredits: remCred,
    rate,
    inputEstimate,
    excludeConnectionIds,
    accountRemaining,
    apiKeyId: stableApiKeyId,
    provider: providerId,
  };
}

export function resolveAccountOutputCap(budget, connectionId) {
  if (!budget) return { skip: false, cap: null };
  let cap = budget.outputCap;
  const accRem = budget.accountRemaining?.get(connectionId);
  if (accRem != null && budget.rate > 0) {
    const accCap = Math.floor(Math.min(budget.remainingCredits, accRem) / budget.rate) - budget.inputEstimate;
    if (accCap <= 0) return { skip: true, cap: null };
    cap = cap == null ? accCap : Math.min(cap, accCap);
  }
  return { skip: false, cap: Number.isFinite(cap) ? cap : null };
}
