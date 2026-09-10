# Task 5.2 — Team budget management routes report

## Delivered

Added the team budget management endpoints:

- `src/app/api/team/budget/route.js`
  - Exports `dynamic = "force-dynamic"`.
  - `GET` loads the singleton team policy and current `monthKey()` usage, normalizes an absent policy to three `null` limits, and reports remaining values as `null` for unlimited limits or clamped non-negative differences for finite limits.
  - `PUT` parses limits through the shared `parseLimits` helper, returns validation failures as HTTP 400, preserves omitted existing fields, clears explicit `null` fields, writes the merged policy, and returns it.
  - Unexpected failures use the repository's JSON HTTP 500 response style.
- `src/app/api/team/budget/reset-usage/route.js`
  - `POST` calls `resetTeamUsage()` (which clears all periods) and returns `{ message: "Team usage reset" }`.
  - Unexpected failures use the existing reset-route HTTP 500 response style.

No in-route auth was added; dashboard/API protection remains in `dashboardGuard`. No secrets or unrelated entities are emitted or modified.

## Tests

Added `tests/unit/team-budget-routes.test.js` covering:

- Missing-policy GET normalization and unlimited remaining values.
- Finite remaining calculations clamped at zero.
- PUT partial merge semantics, explicit null clearing, and invalid-limit HTTP 400 behavior.
- POST reset success and invocation.
- Standard HTTP 500 responses for GET, PUT, and reset failures.

Focused verification:

```text
npx vitest run unit/team-budget-routes.test.js
  Test Files  1 passed
  Tests       8 passed

npx vitest run unit/team-budget-routes.test.js unit/budget-limits.test.js
  Test Files  2 passed
  Tests       20 passed
```

Project-wide suites, formatters, linters, and builds were intentionally not run per task constraints.

## Review / concerns

The routes rely on the existing `setTeamBudgetPolicy` repository return value for the PUT response, matching the repository contract and preserving the normalized three-field policy shape. `GET` uses the host-local calendar month supplied by the existing `monthKey()` convention. No known concerns remain within Task 5.2.

Commit: see `git log` for the final commit containing this report.
