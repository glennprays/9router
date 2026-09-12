import { NextResponse } from "next/server";
import { getApiKeysWithUsage, createApiKey, getApiKeyProviderBudgets, monthKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { parseLimits } from "@/lib/http/budgetLimits.js";
import { getRoutableProviders, validateRoutableProviderBudgets } from "@/lib/http/providerRoutability.js";

export const dynamic = "force-dynamic";

function remaining(limit, used) {
  return limit == null ? null : Math.max(0, Number(limit) - Number(used || 0));
}

function withRemaining(row) {
  const usage = row.usage || {
    periodKey: monthKey(),
    inputTokens: 0,
    outputTokens: 0,
    credits: 0,
  };
  return {
    ...row,
    usage,
    remaining: {
      inputTokens: remaining(row.inputTokensMonthly, usage.inputTokens),
      outputTokens: remaining(row.outputTokensMonthly, usage.outputTokens),
      credits: remaining(row.creditsMonthly, usage.credits),
    },
  };
}


function formatKey(key, period) {
  return {
    ...key,
    usage: {
      periodKey: period,
      inputTokens: key.usage?.inputTokens || 0,
      outputTokens: key.usage?.outputTokens || 0,
      credits: key.usage?.credits || 0,
    },
    remaining: {
      inputTokens: remaining(key.inputTokensMonthly, key.usage?.inputTokens),
      outputTokens: remaining(key.outputTokensMonthly, key.usage?.outputTokens),
      credits: remaining(key.creditsMonthly, key.usage?.credits),
    },
    providerBudgets: (key.providerBudgets || []).map(withRemaining),
  };
}

// GET /api/keys - List API keys
export async function GET() {
  try {
    const period = monthKey();
    const keys = await getApiKeysWithUsage();
    const detailed = await Promise.all(keys.map(async (key) => {
      const providerBudgets = Array.isArray(key.providerBudgets)
        ? key.providerBudgets
        : await getApiKeyProviderBudgets(key.id, period);
      return formatKey({ ...key, providerBudgets }, period);
    }));
    return NextResponse.json({
      keys: detailed,
      routableProviders: await getRoutableProviders(),
    });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  try {
    const body = await request.json();
    const { name } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const parsed = parseLimits(body);
    if (parsed.error) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    try {
      await validateRoutableProviderBudgets(parsed.limits.providerBudgets);
    } catch (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name, machineId, parsed.limits);

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
      inputTokensMonthly: apiKey.inputTokensMonthly,
      outputTokensMonthly: apiKey.outputTokensMonthly,
      creditsMonthly: apiKey.creditsMonthly,
      providerBudgets: parsed.limits.providerBudgets ?? null,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
