import { estimateInputTokens } from "open-sse/utils/usageTracking.js";
import {
  getApiKeyPolicyByKey,
  getApiKeyUsage,
  getKiroCreditRate,
  getTeamBudgetPolicy,
  getTeamUsage,
  getKiroAccountBudgets,
  getAllKiroAccountUsage,
  getProviderConnections,
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

export async function resolveBudgetContext({ apiKey, provider, model, body }) {
  if (provider !== "kiro") return null;

  const memberPolicy = apiKey ? await getApiKeyPolicyByKey(apiKey) : null;
  const teamPolicy = await getTeamBudgetPolicy();
  const accountBudgets = await getKiroAccountBudgets();

  const memberInput = finiteLimit(memberPolicy?.inputTokensMonthly);
  const memberOutput = finiteLimit(memberPolicy?.outputTokensMonthly);
  const memberCredits = finiteLimit(memberPolicy?.creditsMonthly);
  const teamInput = finiteLimit(teamPolicy?.inputTokensMonthly);
  const teamOutput = finiteLimit(teamPolicy?.outputTokensMonthly);
  const teamCredits = finiteLimit(teamPolicy?.creditsMonthly);
  const memberLimited = memberInput !== null || memberOutput !== null || memberCredits !== null;
  const teamLimited = teamInput !== null || teamOutput !== null || teamCredits !== null;
  const anyAccountCeiling = [...accountBudgets.values()].some((value) => finiteLimit(value) !== null);

  if (!memberLimited && !teamLimited && !anyAccountCeiling) return null;
  if ([memberInput, memberOutput, memberCredits, teamInput, teamOutput, teamCredits]
    .some((limit) => Number.isNaN(limit))) {
    return { reject: quotaExceededResponse("Invalid budget configuration") };
  }

  const period = monthKey();
  const memberUsage = memberLimited
    ? await getApiKeyUsage(apiKey, period)
    : { inputTokens: 0, outputTokens: 0, credits: 0 };
  const teamUsage = teamLimited
    ? await getTeamUsage(period)
    : { inputTokens: 0, outputTokens: 0, credits: 0 };
  const memberRemainingInput = memberInput === null
    ? Infinity : memberInput - (memberUsage?.inputTokens ?? 0);
  const memberRemainingOutput = memberOutput === null
    ? Infinity : memberOutput - (memberUsage?.outputTokens ?? 0);
  const memberRemainingCredits = memberCredits === null
    ? Infinity : memberCredits - (memberUsage?.credits ?? 0);
  const teamRemainingInput = teamInput === null
    ? Infinity : teamInput - (teamUsage?.inputTokens ?? 0);
  const teamRemainingOutput = teamOutput === null
    ? Infinity : teamOutput - (teamUsage?.outputTokens ?? 0);
  const teamRemainingCredits = teamCredits === null
    ? Infinity : teamCredits - (teamUsage?.credits ?? 0);
  const remIn = Math.min(memberRemainingInput, teamRemainingInput);
  const remOut = Math.min(memberRemainingOutput, teamRemainingOutput);
  const remCred = Math.min(memberRemainingCredits, teamRemainingCredits);

  if (remIn <= 0 || remOut <= 0 || remCred <= 0) {
    return { reject: quotaExceededResponse("Insufficient quota") };
  }

  const inputEstimate = estimateInputTokens(body);
  if (Number.isFinite(remIn) && inputEstimate > remIn) {
    return { reject: quotaExceededResponse("Input token budget exceeded") };
  }

  const rate = Number.isFinite(remCred) ? await getKiroCreditRate(model) : 0;
  const creditBoundedOutput = rate > 0
    ? Math.floor(remCred / rate) - inputEstimate
    : Infinity;
  if (rate > 0 && creditBoundedOutput <= 0) {
    return { reject: quotaExceededResponse("Credit budget would be exceeded") };
  }

  const outputCap = Math.min(Number.isFinite(remOut) ? remOut : Infinity, creditBoundedOutput);
  let excludeConnectionIds = [];
  let accountRemaining = null;
  if (anyAccountCeiling) {
    const conns = await getProviderConnections({ provider: "kiro", isActive: true });
    const usageMap = await getAllKiroAccountUsage(period);
    accountRemaining = new Map();
    let eligibleCount = 0;
    for (const connection of conns) {
      const ceiling = finiteLimit(accountBudgets.get(connection.id));
      if (ceiling === null) {
        eligibleCount += 1;
        continue;
      }
      const remaining = ceiling - (usageMap.get(connection.id) || 0);
      if (remaining <= 0) {
        excludeConnectionIds.push(connection.id);
      } else {
        eligibleCount += 1;
        accountRemaining.set(connection.id, remaining);
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
