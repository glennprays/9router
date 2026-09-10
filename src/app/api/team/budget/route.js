import { NextResponse } from "next/server";
import {
  getTeamBudgetPolicy,
  getTeamUsage,
  monthKey,
  setTeamBudgetPolicy,
} from "@/lib/localDb";
import { parseLimits } from "@/lib/http/budgetLimits.js";

export const dynamic = "force-dynamic";

const EMPTY_POLICY = {
  inputTokensMonthly: null,
  outputTokensMonthly: null,
  creditsMonthly: null,
};

function remaining(limit, used) {
  return limit == null ? null : Math.max(0, limit - used);
}

export async function GET() {
  try {
    const policy = (await getTeamBudgetPolicy()) ?? EMPTY_POLICY;
    const usage = await getTeamUsage(monthKey());

    return NextResponse.json({
      policy,
      usage,
      remaining: {
        inputTokens: remaining(policy.inputTokensMonthly, usage.inputTokens),
        outputTokens: remaining(policy.outputTokensMonthly, usage.outputTokens),
        credits: remaining(policy.creditsMonthly, usage.credits),
      },
    });
  } catch (error) {
    console.log("Error fetching team budget:", error);
    return NextResponse.json({ error: "Failed to fetch team budget" }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const body = await request.json();
    const parsed = parseLimits(body);
    if (parsed.error) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const existing = (await getTeamBudgetPolicy()) ?? EMPTY_POLICY;
    const policy = await setTeamBudgetPolicy({ ...existing, ...parsed.limits });

    return NextResponse.json({ policy });
  } catch (error) {
    console.log("Error updating team budget:", error);
    return NextResponse.json({ error: "Failed to update team budget" }, { status: 500 });
  }
}
