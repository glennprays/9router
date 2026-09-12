import { getProviderConnections, getProviderNodes } from "@/lib/localDb";
import { AI_PROVIDERS } from "@/shared/constants/providers.js";
import { canonicalizeProviderId } from "./budgetLimits.js";

export async function getRoutableProviders() {
  const providers = new Map();
  for (const provider of Object.values(AI_PROVIDERS)) {
    if (provider.noAuth) providers.set(provider.id, { id: provider.id, name: provider.name || provider.id });
  }
  for (const connection of await getProviderConnections({ isActive: true })) {
    const id = canonicalizeProviderId(connection.provider);
    if (!id) continue;
    providers.set(id, { id, name: AI_PROVIDERS[id]?.name || id });
  }
  for (const node of await getProviderNodes()) {
    if (!node.id) continue;
    providers.set(node.id, { id: node.id, name: node.name || node.id });
  }
  return [...providers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function validateRoutableProviderBudgets(budgets, { allow = [] } = {}) {
  if (budgets == null) return null;
  const routable = new Set((await getRoutableProviders()).map((provider) => provider.id));
  const allowed = new Set(allow);
  for (const budget of budgets) {
    if (!routable.has(budget.provider) && !allowed.has(budget.provider)) {
      throw new Error(`Provider is not currently routable: ${budget.provider}`);
    }
  }
  return budgets;
}
