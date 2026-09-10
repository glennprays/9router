export function parseLimit(value, field) {
  if (value === undefined) return { value };
  if (value === null || value === "") return { value: null };
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { error: `${field} must be a non-negative number` };
  }
  return { value: parsed };
}

export function parseLimits(body, fields = ["inputTokensMonthly", "outputTokensMonthly", "creditsMonthly"]) {
  const limits = {};
  for (const field of fields) {
    const result = parseLimit(body[field], field);
    if (result.error) return result;
    if (result.value !== undefined) limits[field] = result.value;
  }
  return { limits };
}
