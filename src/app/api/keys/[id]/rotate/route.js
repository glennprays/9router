import { NextResponse } from "next/server";
import { rotateApiKey } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const result = await rotateApiKey(id);
    if (!result) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key: result.key }, { status: 201 });
  } catch (error) {
    console.log("Error rotating key:", error);
    return NextResponse.json({ error: "Failed to rotate key" }, { status: 500 });
  }
}
