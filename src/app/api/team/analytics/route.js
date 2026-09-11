import { NextResponse } from "next/server";
import { getTeamAnalytics } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d"]);

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "30d";
    const apiKey = searchParams.get("apiKey") || null;

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    const data = await getTeamAnalytics(period, apiKey);
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Failed to get team analytics:", error);
    return NextResponse.json({ error: "Failed to fetch team analytics" }, { status: 500 });
  }
}
