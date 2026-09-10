import { NextResponse } from "next/server";
import { getProviderConnectionById, setKiroAccountBudget } from "@/lib/localDb";
import { parseLimit } from "@/lib/http/budgetLimits.js";
import { resolveProviderId } from "@/shared/constants/providers.js";

export const dynamic = "force-dynamic";

// PUT /api/kiro/accounts/[connectionId]/budget - Set one Kiro account's monthly
// credit ceiling. `null` (or "") clears it. The connection record is only used
// for the existence/provider check and is never serialized into the response.
export async function PUT(request, { params }) {
  try {
    const { connectionId } = await params;

    const conn = await getProviderConnectionById(connectionId);
    if (!conn || resolveProviderId(conn.provider) !== "kiro") {
      return NextResponse.json({ error: "Kiro account not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = parseLimit(body.creditsMonthly, "creditsMonthly");
    if (parsed.error) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    if (parsed.value === undefined) {
      return NextResponse.json({ error: "creditsMonthly is required" }, { status: 400 });
    }

    await setKiroAccountBudget(connectionId, parsed.value);

    return NextResponse.json({ connectionId, creditsMonthly: parsed.value });
  } catch (error) {
    console.log("Error updating Kiro account budget:", error);
    return NextResponse.json({ error: "Failed to update Kiro account budget" }, { status: 500 });
  }
}
