import { NextResponse } from "next/server";
import { getProviderConnectionById, resetKiroAccountUsageByConnectionId } from "@/lib/localDb";
import { resolveProviderId } from "@/shared/constants/providers.js";

export const dynamic = "force-dynamic";

// POST /api/kiro/accounts/[connectionId]/reset-usage - Zero one Kiro account's
// month credit counters (all periods). Leaves usageHistory, team, and member
// counters untouched. The connection record is only used for the
// existence/provider check and is never serialized into the response.
export async function POST(request, { params }) {
  try {
    const { connectionId } = await params;

    const conn = await getProviderConnectionById(connectionId);
    if (!conn || resolveProviderId(conn.provider) !== "kiro") {
      return NextResponse.json({ error: "Kiro account not found" }, { status: 404 });
    }

    await resetKiroAccountUsageByConnectionId(connectionId);

    return NextResponse.json({ message: "Account usage reset" });
  } catch (error) {
    console.log("Error resetting Kiro account usage:", error);
    return NextResponse.json({ error: "Failed to reset usage" }, { status: 500 });
  }
}
