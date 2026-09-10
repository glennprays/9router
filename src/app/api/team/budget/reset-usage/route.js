import { NextResponse } from "next/server";
import { resetTeamUsage } from "@/lib/localDb";

export async function POST() {
  try {
    await resetTeamUsage();
    return NextResponse.json({ message: "Team usage reset" });
  } catch (error) {
    console.log("Error resetting team usage:", error);
    return NextResponse.json({ error: "Failed to reset usage" }, { status: 500 });
  }
}
