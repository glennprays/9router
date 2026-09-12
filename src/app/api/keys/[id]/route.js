import { NextResponse } from "next/server";
import {
  deleteApiKey,
  getApiKeyById,
  getApiKeyProviderBudgets,
  updateApiKey,
} from "@/lib/localDb";
import { parseLimits } from "@/lib/http/budgetLimits.js";
import { validateRoutableProviderBudgets } from "@/lib/http/providerRoutability.js";

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    const providerBudgets = await getApiKeyProviderBudgets(id);
    return NextResponse.json({ key: { ...key, providerBudgets } });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const parsed = parseLimits(body);
    if (parsed.error) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const hasProviderBudgets = Object.prototype.hasOwnProperty.call(body, "providerBudgets");
    if (hasProviderBudgets) {
      const existingBudgets = await getApiKeyProviderBudgets(id);
      const staleProviders = existingBudgets.map((budget) => budget.provider);
      try {
        await validateRoutableProviderBudgets(parsed.limits.providerBudgets, { allow: staleProviders });
      } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }

    const updateData = { ...parsed.limits };
    if (isActive !== undefined) updateData.isActive = isActive;

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
