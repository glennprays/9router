import { NextResponse } from "next/server";
import { killAppProcesses, spawnUpdaterAndExit } from "@/lib/appUpdater";
import { getUpdateSource } from "@/lib/updater/updateMode.js";

export async function startUpdateForMode({ env = process.env, startNpmUpdate }) {
  const source = getUpdateSource(env);
  if (source === "external") {
    return NextResponse.json(
      {
        success: false,
        message:
          "Updates are managed externally. Download the reviewed tag-pinned deployment script from GitHub and run update --tag <tag>.",
      },
      { status: 409 }
    );
  }
  if (source === "invalid") {
    return NextResponse.json(
      { success: false, message: "Invalid UPDATE_SOURCE configuration." },
      { status: 500 }
    );
  }
  return startNpmUpdate();
}

export async function POST() {
  return startUpdateForMode({
    env: process.env,
    startNpmUpdate: async () => {
      if (process.env.NODE_ENV !== "production") {
        return NextResponse.json(
          { success: false, message: "Update is only available in production build (9router CLI)" },
          { status: 403 }
        );
      }

      try {
        // Kill sibling processes (cloudflared, MITM, stray next-server) to release file locks on Windows
        await killAppProcesses();
      } catch { /* best effort */ }

      // Schedule detached updater then exit current server process
      spawnUpdaterAndExit();

      return NextResponse.json({ success: true, message: "Updater started. This app will exit shortly." });
    },
  });
}
