import { NextResponse } from "next/server";
import {
  getAllKiroAccountUsage,
  getKiroAccountBudgets,
  getProviderConnections,
  monthKey,
} from "@/lib/localDb";

export const dynamic = "force-dynamic";

function remaining(limit, used) {
  return limit == null ? null : Math.max(0, limit - used);
}

// Lists active Kiro accounts with their monthly credit ceiling, current-month
// usage and remaining headroom. Emits display/status fields only — never
// tokens, API keys, or any other credential material from the connection.
export async function GET() {
  try {
    const periodKey = monthKey();
    const [connections, budgets, usage] = await Promise.all([
      getProviderConnections({ provider: "kiro", isActive: true }),
      getKiroAccountBudgets(),
      getAllKiroAccountUsage(periodKey),
    ]);

    const accounts = connections.map((c) => {
      const creditsMonthly = budgets.get(c.id) ?? null;
      const credits = usage.get(c.id) || 0;
      return {
        connectionId: c.id,
        name: c.displayName || c.name || c.email || c.id,
        creditsMonthly,
        credits,
        remaining: remaining(creditsMonthly, credits),
        testStatus: c.testStatus || null,
        lastError: c.lastError || null,
      };
    });

    return NextResponse.json({ periodKey, accounts });
  } catch (error) {
    console.log("Error fetching Kiro account budgets:", error);
    return NextResponse.json({ error: "Failed to fetch Kiro account budgets" }, { status: 500 });
  }
}
