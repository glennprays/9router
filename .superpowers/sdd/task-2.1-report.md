# Task 2.1 Report — Database barrel + backup round-trip

## Status
Implemented and verified the Phase 2.1 database barrel and backup wiring.

## Changes
- Updated `src/lib/db/index.js` to export all required Team budget and Kiro account budget repository functions.
- Added exact raw-row exports for `teamBudgetPolicy`, `teamUsage`, `kiroAccountBudget`, and `kiroAccountUsage`, including `updatedAt`.
- Added transactional wipe statements for all four tables during import.
- Added `INSERT OR REPLACE` import loops for all four tables, with legacy-safe `payload.<table> || []` handling, nullable limit defaults, numeric `?? 0` usage defaults, and timestamp fallbacks.
- Added focused round-trip coverage in `tests/unit/db-sqlite-vs-lowdb.test.js` covering policy rows, team usage, account budget rows, account usage rows, and a legacy payload with no new keys.

## TDD evidence
- RED: the new focused test failed because `sqliteDb.setTeamBudgetPolicy` was not exported (`TypeError: ... is not a function`).
- GREEN: after barrel and backup wiring, the focused test passed.

## Verification
Command:
`cd tests && npx vitest run unit/db-sqlite-vs-lowdb.test.js`

Result: 1 test file passed; 22 tests passed, 0 failed.

Additional focused command:
`npx vitest run unit/db-sqlite-vs-lowdb.test.js -t 'exports and imports team and Kiro account budget rows'`

Result: 1 test passed; 21 skipped.

## Scope / concerns
Only `src/lib/db/index.js` and the focused existing DB backup test were changed. No formatter, linter, or project-wide suite was run. The report itself is task-required and intentionally remains under `.superpowers/sdd/`.
