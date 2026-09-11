# Team Kiro Pool v1

**Date:** 2026-09-10  
**Status:** Approved design; implementation plan pending user spec review

## Problem

9Router can now apply monthly input-token, output-token, and Kiro-credit budgets to individual downstream API keys. A small team sharing several Kiro subscriptions also needs an aggregate guard so one teammate cannot consume the whole upstream pool while other members still have individual quota remaining.

The first version targets one centrally hosted 9Router gateway. Each teammate receives a distinct downstream API key. The gateway routes those requests through the configured Kiro account pool and enforces both member-level and team-level limits.

## Goals

- Enforce a hard admission cap for aggregate monthly Kiro usage.
- Preserve the existing per-key monthly input, output, and credit budgets.
- Attribute usage to individual downstream API keys.
- Give an administrator visibility into team and member consumption.
- Allow administrators to update limits, reset usage, revoke keys, and rotate keys.
- Keep non-Kiro traffic unaffected.
- Keep the first version central-gateway-only without adding a second user/RBAC system.
- Enforce configured monthly credit limits per Kiro upstream account.

## Non-goals

- Multiple independently running gateways with synchronized reservations.
- User invitations, login identities, roles, or workspace membership.
- Email, Slack, webhook, or other external notifications.
- RPM, concurrency, or model allowlist policy in the first version.
- Exact zero-overshoot guarantees for simultaneous in-flight Kiro requests.
- Automatic discovery or guarantee of provider-side quota balances; account ceilings are administrator-configured.

## Core model

### Team policy

Add a singleton `teamBudgetPolicy` table:

```text
id INTEGER PRIMARY KEY CHECK (id = 1)
inputTokensMonthly INTEGER NULL
outputTokensMonthly INTEGER NULL
creditsMonthly REAL NULL
updatedAt TEXT NOT NULL
```

`NULL` means unlimited for that dimension. A missing row behaves as an unlimited policy.

### Team usage

Add a `teamUsage` table:

```text
periodKey TEXT PRIMARY KEY
inputTokens INTEGER DEFAULT 0
outputTokens INTEGER DEFAULT 0
credits REAL DEFAULT 0
updatedAt TEXT
```

`periodKey` is the local calendar month in `YYYY-MM` form, matching the existing `apiKeyUsage` behavior.

### Kiro account policy and usage

Add `kiroAccountBudget` keyed by `connectionId` and `kiroAccountUsage` keyed by `(connectionId, periodKey)`:

```text
kiroAccountBudget
connectionId TEXT PRIMARY KEY
creditsMonthly REAL NULL
updatedAt TEXT NOT NULL

kiroAccountUsage
connectionId TEXT
periodKey TEXT
credits REAL DEFAULT 0
updatedAt TEXT
PRIMARY KEY (connectionId, periodKey)
```

These rows apply only to Kiro provider connections. `creditsMonthly` is the locally configured ceiling for that subscription; `NULL` means no local account ceiling. `periodKey` uses the local calendar month, matching team and member usage. The selected `connectionId` is already recorded in `usageHistory`, so completed Kiro credits can be attributed to the correct subscription.
For example, three accounts configured at `2,000` credits each use account ceilings of `2,000` and a team `creditsMonthly` ceiling of `6,000`. The administrator may set a lower team ceiling.

### Member policy and usage

Keep the existing `apiKeys` policy columns and `apiKeyUsage` counters:

- `inputTokensMonthly`
- `outputTokensMonthly`
- `creditsMonthly`
- `inputTokens`
- `outputTokens`
- `credits`

The existing API-key `name` is the v1 owner/team-member label. No separate identity table is introduced.

### Schema migration

The change is additive. Bump the schema version and let the declarative schema synchronizer create the new tables and indexes. No destructive migration is required. Existing keys and usage remain valid and unlimited at the team level until an administrator configures a policy.

## Admission and accounting

### Admission

For a Kiro request with a downstream API key:

1. Resolve the member policy and current-month member usage.
2. Resolve the team policy and current-month team usage.
3. Resolve active Kiro connections and exclude accounts whose finite local credit ceiling is exhausted for the current month.
4. If no eligible Kiro account remains, reject with HTTP `429` and an OpenAI-compatible `insufficient_quota` body.
5. Treat each `NULL` dimension as unlimited.
6. Reject with HTTP `429` and an OpenAI-compatible `insufficient_quota` body if the member or team policy has no remaining input, output, or credit allowance.
7. Estimate input tokens from the request body and reject if the estimate exceeds either finite input allowance.
8. Compute the output cap as the minimum finite allowance among:
   - member output tokens remaining;
   - team output tokens remaining;
   - selected-account credit allowance;
   - empirical credit-based output allowance when a model credit rate is known.
9. Apply the cap to OpenAI-style output fields and Gemini-native `generationConfig.maxOutputTokens` fields before translation and dispatch.
10. Continue to bypass this gate for non-Kiro providers.

The selected account remains bound to the request attempt. Existing upstream-error fallback may move the attempt to another eligible Kiro account; the account budget check is repeated before that fallback attempt.

The team and account caps are hard for subsequent admissions after persisted usage reaches their limits. Exact Kiro credits arrive only at stream completion, so simultaneous in-flight requests can collectively exceed either cap by their combined final usage. The first version documents this bound instead of introducing reservations or a concurrency system.

### Completion accounting

On a completed request, persist exact Kiro metering credits and token usage in one database transaction:

- increment `apiKeyUsage` for the downstream key;
- increment `teamUsage` for the current month;
- increment `kiroAccountUsage` for the selected `connectionId` and current month;
- preserve `kiro_credits` in `usageHistory.tokens`;
- use existing duplicate detection so retries do not increment any counter twice.

A non-Kiro request never increments any Kiro budget counter, even when it carries the same downstream API key.

### Reset semantics

- Reset member usage: clear every usage period for that API key.
- Reset team usage: clear every team usage period; it does not clear member or account counters.
- Reset account usage: clear every usage period for the selected account; it does not clear team or member counters.
- All resets clear every stored period (mirroring the existing per-key reset), not only the current month.
- Reset does not delete historical `usageHistory` records.
- Deleting a Kiro connection removes its account budget and usage rows; a re-added account starts unlimited at zero.

## Management API

Add the following protected dashboard APIs:

```text
GET  /api/team/budget
PUT  /api/team/budget
POST /api/team/budget/reset-usage
GET  /api/kiro/accounts/budget
PUT  /api/kiro/accounts/:connectionId/budget
POST /api/kiro/accounts/:connectionId/reset-usage
POST /api/keys/:id/rotate
```

### `GET /api/team/budget`

Returns the configured policy and current local-month usage, including remaining values for finite dimensions.

### `GET /api/kiro/accounts/budget`

Returns each active Kiro connection's display name, connection status, configured local credit ceiling, current local-month usage, and remaining credits. It never returns provider credentials.

### `PUT /api/kiro/accounts/:connectionId/budget`

Accepts an optional non-negative finite `creditsMonthly` value. `null` clears that account's local ceiling. Unknown or non-Kiro connection IDs return `404`; invalid values return `400`.

### `POST /api/kiro/accounts/:connectionId/reset-usage`

Clears every stored usage period for the selected account and returns `{ message }`. Historical request records remain intact.

### `PUT /api/team/budget`

Accepts optional non-negative numeric values:

```json
{
  "inputTokensMonthly": 100000,
  "outputTokensMonthly": 50000,
  "creditsMonthly": 100
}
```

`null` clears a dimension. Invalid, negative, or non-finite values return `400`.

### `POST /api/team/budget/reset-usage`

Clears every stored team usage period and returns `{ message }`. Historical request records remain intact.

### `POST /api/keys/:id/rotate`

Generates a new downstream API key and invalidates the old value immediately. Because member usage counters are keyed by the raw key string, rotation must migrate that key's `apiKeyUsage` rows from the old key to the new key in the same transaction. The key name, policy, and usage counters are preserved; historical `usageHistory.apiKey` values remain unchanged for auditability. The new secret is returned once. Unknown IDs return `404`.

## Dashboard

Add a Team Kiro Budget card to the existing endpoint/API-key dashboard:

- input, output, and credit limit fields;
- current-month usage and remaining values;
- warning state at 80% and 90% usage;
- update limits action;
- reset team usage action.

Add a Kiro account pool section:

- each subscription's configured ceiling, current usage, remaining credits, status, and reset action;
- team totals that aggregate all configured Kiro accounts;
- member totals that aggregate each downstream API key.

Extend each API-key row with:

- owner/name label;
- member usage versus member limit;
- revoke/pause control;
- rotate control;
- reset member usage control.

Warnings are dashboard-only in v1. No notification delivery system is added.

## Security and failure behavior

- Team policy, account budget/reset, and key rotation routes use the existing dashboard protection.
- API-key secrets are returned only at creation or rotation by the new behavior. The existing list response contract is preserved; the dashboard masks values client-side. No additional secret exposure is introduced.
- Invalid policy values fail closed with `400` at management boundaries and `429 insufficient_quota` if malformed stored data reaches admission.
- Usage persistence failures remain fail-open for the request path, matching existing usage accounting behavior; the request itself is not converted into an upstream failure solely because a counter write failed.
- A rotated key invalidates the old key through the existing API-key validation path.

## Testing

Add deterministic unit/integration coverage for:

1. Fresh/missing team policy behaves as unlimited.
2. Team policy create/update/clear and numeric validation.
3. Team usage upsert separates calendar months.
4. Missing account policy behaves as unlimited for that Kiro connection.
5. Account policy create/update/clear and numeric validation.
6. An exhausted Kiro account is excluded before dispatch.
7. The account pool selects another eligible Kiro account when one account reaches its local ceiling.
8. Team cap blocks a request while member quota remains.
9. Member cap blocks a request while team quota remains.
10. Output clamp uses the smaller member/team/account allowance.
11. Known credit rates further reduce the output clamp.
12. Unknown credit rates do not fabricate a reservation.
13. Completed Kiro usage increments member, team, and selected-account counters once.
14. Duplicate saves do not double-count any counter.
15. Team reset clears team counters without deleting history or account/member counters.
16. Account reset clears only the selected account's current counter.
17. Key rotation invalidates the old key and preserves policy/usage.
18. Non-Kiro requests remain unlimited and do not charge Kiro counters.
19. Concurrent in-flight overshoot is documented and bounded by the final completions rather than incorrectly asserted as impossible.
20. Central-gateway HTTP smoke: configure three Kiro accounts at 2,000 credits each, complete requests across the pool, observe account/team/member usage, receive `429` after an account or team ceiling is exhausted, reset, and verify admission resumes.

## Rollout order

1. Add account policy/usage schema, repositories, exports, and transactional three-scope accounting.
2. Add account-aware Kiro selection, admission checks, and combined output clamping.
3. Add team and account budget APIs plus key rotation API.
4. Add dashboard controls and account/team/member usage display.
5. Run focused tests, route contract tests, and isolated central-gateway smoke.
6. Add the changelog entry and commit the implementation.
