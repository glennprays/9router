import { NextResponse } from "next/server";
import {
  getApiKeyById,
  getApiKeyProviderBudgets,
  resetApiKeyProviderUsage,
} from "@/lib/localDb";
import { canonicalizeProviderId } from "@/lib/http/budgetLimits.js";

export async function POST(request, { params }) {
  try {
    const { id, provider: rawProvider } = await params;
    const provider = canonicalizeProviderId(decodeURIComponent(rawProvider || ""));
    const key = await getApiKeyById(id);
    if (!key || !provider) {
      return NextResponse.json({ error: "Key or provider not found" }, { status: 404 });
    }

    const budgets = await getApiKeyProviderBudgets(id);
    const known = budgets.some((budget) => budget.provider === provider);
    if (!known) {
      return NextResponse.json({ error: "Provider usage not found" }, { status: 404 });
    }

    await resetApiKeyProviderUsage(id, provider);
    return NextResponse.json({ message: "Provider usage reset", provider });
  } catch (error) {
    console.log("Error resetting provider usage:", error);
    return NextResponse.json({ error: "Failed to reset provider usage" }, { status: 500 });
  }
}
