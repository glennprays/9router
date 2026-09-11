# Task 1 Report: External Update Mode Guard

## Status

Implemented the external update mode guard for the dashboard version, update, and shutdown routes.

## Changes

- Added `src/lib/updater/updateMode.js` with:
  - `getUpdateSource`, defaulting missing and empty `UPDATE_SOURCE` to `npm`.
  - `isExternalUpdateSource`.
  - `buildExternalVersionResponse`.
- Exported `buildVersionResponse` from the version route. External mode returns managed-external state without invoking the npm registry lookup; npm mode retains the existing cache and version comparison shape.
- Exported `startUpdateForMode` from the update route. External mode returns HTTP 409 before the npm updater or process-kill path; invalid mode returns HTTP 500.
- Exported `shutdownForMode` from the shutdown route. External mode returns HTTP 409 before process killing or delayed process exit; invalid mode returns HTTP 500.
- Added the commented `UPDATE_SOURCE=external` example to `.env.example`.
- Added focused unit coverage for default, empty, external, invalid, npm-compatible, and route-level behavior.

## TDD Evidence

### RED

Command:

```bash
cd tests && npx vitest run unit/external-update-mode.test.js
```

Output:

```text
RUN  v4.1.11 /Users/glennpray/projects/9router/tests

❯ unit/external-update-mode.test.js (0 test)

Failed Suites 1
Error: Cannot find package '@/lib/updater/updateMode.js' imported from /Users/glennpray/projects/9router/tests/unit/external-update-mode.test.js
```

The focused test failed before implementation because the new mode module did not exist.

### GREEN

Command:

```bash
cd tests && npx vitest run unit/external-update-mode.test.js
```

Output:

```text
RUN  v4.1.11 /Users/glennpray/projects/9router/tests

Test Files  1 passed (1)
Tests  11 passed (11)
```

## Self-review

- External mode branches before npm lookup, updater spawning, process killing, and delayed shutdown exit.
- Invalid sources fail closed with HTTP 500 on all three route surfaces.
- Missing and empty sources remain npm-compatible.
- npm version lookup/comparison, updater callback, and process-kill behavior are covered by focused tests.
- No CLI updater, updater configuration, deployment script, CI/CD, or systemd asset changes were made.

## Concerns

None identified within the requested scope. Project-wide suites, formatters, and linters were intentionally not run per the task instructions.
