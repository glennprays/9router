import { NextResponse } from "next/server";
import { resetApiKeyUsageById } from "@/lib/localDb";

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const ok = await resetApiKeyUsageById(id);
    if (!ok) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ message: "Usage reset" });
  } catch (error) {
    console.log("Error resetting key usage:", error);
    return NextResponse.json({ error: "Failed to reset usage" }, { status: 500 });
  }
}
