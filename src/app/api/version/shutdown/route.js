import { NextResponse } from "next/server";
import { killAppProcesses } from "@/lib/appUpdater";
import { getUpdateSource } from "@/lib/updater/updateMode.js";

export async function shutdownForMode({ env = process.env, killAppProcesses }) {
  const source = getUpdateSource(env);
  if (source === "external") {
    return NextResponse.json(
      { success: false, message: "Shutdown is managed externally." },
      { status: 409 }
    );
  }
  if (source === "invalid") {
    return NextResponse.json(
      { success: false, message: "Invalid UPDATE_SOURCE configuration." },
      { status: 500 }
    );
  }

  try {
    await killAppProcesses();
  } catch { /* best effort */ }
  return null;
}

// Shutdown app to release file locks for manual update
export async function POST() {
  const modeResponse = await shutdownForMode({
    env: process.env,
    killAppProcesses,
  });
  if (modeResponse) return modeResponse;

  const response = NextResponse.json({ success: true, message: "Shutting down for manual update..." });

  setTimeout(() => process.exit(0), 500);

  return response;
}
