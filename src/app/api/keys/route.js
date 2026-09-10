import { NextResponse } from "next/server";
import { getApiKeysWithUsage, createApiKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";

function parseLimit(value, field) {
  if (value === undefined) return { value };
  if (value === null || value === "") return { value: null };
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { error: `${field} must be a non-negative number` };
  }
  return { value: parsed };
}

function parseLimits(body) {
  const limits = {};
  for (const field of ["inputTokensMonthly", "outputTokensMonthly", "creditsMonthly"]) {
    const result = parseLimit(body[field], field);
    if (result.error) return result;
    if (result.value !== undefined) limits[field] = result.value;
  }
  return { limits };
}

export const dynamic = "force-dynamic";

// GET /api/keys - List API keys
export async function GET() {
  try {
    const keys = await getApiKeysWithUsage();
    return NextResponse.json({ keys });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  try {
    const body = await request.json();
    const { name } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const parsed = parseLimits(body);
    if (parsed.error) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name, machineId, parsed.limits);

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
      inputTokensMonthly: apiKey.inputTokensMonthly,
      outputTokensMonthly: apiKey.outputTokensMonthly,
      creditsMonthly: apiKey.creditsMonthly,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
