# Task 5: Final Verification and Cleanup

## Status

Complete for the checks available on macOS. The focused updater/deployment tests, production build, focused baseline verification, disposable external-mode API check, and authenticated dashboard smoke all passed. Linux-only and real-VPS checks are deferred.

## Checks

### 1. Focused tests

Command:

```text
cd tests && npx vitest run unit/external-update-mode.test.js unit/github-deploy-script.test.js
```

Exact output:

```text
 RUN  v4.1.11 /Users/glennpray/projects/9router/tests


 Test Files  2 passed (2)
      Tests  14 passed (14)
   Start at  13:18:32
   Duration  341ms (transform 171ms, setup 0ms, import 269ms, tests 52ms, environment 0ms)


Wall time: 1.06 seconds
```

### 2. Production build

Command:

```text
npm run build
```

Exit status: 0. Exact build result:

```text
> 9router-app@0.5.69 build
> next build --webpack

▲ Next.js 16.3.4 (webpack)
✓ Running next.config.mjs took 15ms
- Experiments (use with caution):
  · optimizePackageImports
  · proxyClientMaxBodySize: "128mb"

  Creating an optimized production build ...
✓ Compiled successfully in 15.0s
  Running TypeScript ...
  Finished TypeScript in 7ms ...
  Collecting page data using 7 workers ...
[DB] Driver: better-sqlite3 | file: /Users/glennpray/.9router/db/data.sqlite
[DB] Driver: better-sqlite3 | file: /Users/glennpray/.9router/db/data.sqlite
[DB] Driver: better-sqlite3 | file: /Users/glennpray/.9router/db/data.sqlite
[DB] Driver: better-sqlite3 | file: /Users/glennpray/.9router/db/data.sqlite
[DB] Driver: better-sqlite3 | file: /Users/glennpray/.9router/db/data.sqlite
[DB] Driver: better-sqlite3 | file: /Users/glennpray/.9router/db/data.sqlite
[DB] Driver: better-sqlite3 | file: /Users/glennpray/.9router/db/data.sqlite
  Generating static pages using 7 workers (0/138) ...
  Generating static pages using 7 workers (34/138)
  Generating static pages using 7 workers (68/138)
  Generating static pages using 7 workers (103/138)
✓ Generating static pages using 7 workers (138/138) in 407ms
  Finalizing page optimization ...
  Collecting build traces ...

ƒ Proxy (Middleware)

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand

> 9router-app@0.5.69 postbuild
> node scripts/copy-standalone-assets.mjs

[standalone-assets] Copied static assets to /Users/glennpray/projects/9router/.next/standalone/.next/static
[standalone-assets] Copied public assets to /Users/glennpray/projects/9router/.next/standalone/public
[standalone-assets] Copied custom-server.js to /Users/glennpray/projects/9router/.next/standalone/custom-server.js
```

The route table completed with 138 static pages and the postbuild asset-copy step copied `.next/static`, `public`, and `custom-server.js` into `.next/standalone`.

### 3. Baseline regression verifier

The exact brief command was run first:

```text
node tests/__baseline__/verify-no-regression.mjs
```

Exact output:

```text
Missing results.json path
```

Exit status: 2. This is a pre-existing invocation mismatch: the verifier source requires a positional `<current-results.json>` argument. No source was changed.

To exercise the verifier without running unrelated project-wide tests, the focused tests were rerun with Vitest's JSON reporter:

```text
cd tests && npx vitest run unit/external-update-mode.test.js unit/github-deploy-script.test.js --reporter=json --outputFile=/tmp/9router-task5-results.json
```

Exact output:

```text
JSON report written to /tmp/9router-task5-results.json
```

Then:

```text
node tests/__baseline__/verify-no-regression.mjs /tmp/9router-task5-results.json
```

Exact output:

```text
✅ No regression. (now fails=0, baseline known=24, all known)
```

### 4. Disposable external-mode API smoke

A production standalone server was started using a temporary environment file and temporary data directory, without using port 20128:

```text
UPDATE_SOURCE=external
DATA_DIR=/tmp/9router-task5-data
PORT=20129
HOSTNAME=127.0.0.1
NODE_ENV=production
JWT_SECRET=task5-verification-secret
```

The disposable server was started through the process tool on port 20129 and stopped cleanly after checks. The existing `9router-dev-ui` process was not stopped or restarted.

Authenticated requests (required by the always-protected update/shutdown routes) produced:

```text
GET /api/version
{"updateSource":"external","currentVersion":"0.5.69","latestVersion":null,"hasUpdate":false,"managedExternally":true}

POST /api/version/update
HTTP 409
{"success":false,"message":"Updates are managed externally."}

POST /api/version/shutdown
HTTP 409
{"success":false,"message":"Shutdown is managed externally."}
```

An unauthenticated probe returned HTTP 401 for both protected POST routes, confirming the dashboard guard remains active; the authenticated external-mode behavior is the required HTTP 409 result.

### 5. Actual dashboard smoke

The browser opened `http://127.0.0.1:20129/dashboard` against the disposable server with a temporary authenticated session.

Observed dashboard result:

```text
URL: http://127.0.0.1:20129/dashboard
Title: 9Router - AI Infrastructure Management
```

The rendered dashboard contained normal content including `API endpoint configuration`, `API Keys`, and the navigation. Browser assertions returned:

```text
{
  "hasNpmUpdateBanner": false,
  "hasInstallCommand": false,
  "hasDashboardContent": true,
  "buttons": [
    "perm_media\nMedia Providers\nexpand_more",
    "computer\n9Remote",
    "perm_mediaMedia Providersexpand_more",
    "computer9Remote",
    "menu",
    "volunteer_activism\nDonate",
    "light_mode",
    "🇺🇸",
    "grid_view",
    "content_copy",
    "cloud_upload\nEnable",
    "vpn_lock\nEnable",
    "add\nCreate Key",
    "visibility",
    "content_copy",
    "restart_alt\nReset usage",
    "autorenew\nRotate",
    "delete",
    "save\nSave",
    "restart_alt\nReset usage"
  ],
  "navLinks": [
    "hub\n9Router Proxy\nv0.5.69",
    "api\nEndpoint & Key",
    "dns\nProviders",
    "layers\nCombo & Vision Adapter",
    "bar_chart\nUsage",
    "data_usage\nQuota Tracker",
    "savings\nToken Saver",
    "terminal\nCLI Tools",
    "lan\nProxy Pools",
    "extension\nSkills",
    "terminal\nConsole Log",
    "translate\n9English",
    "settings\nSettings",
    "hub9Router Proxyv0.5.69",
    "apiEndpoint & Key",
    "dnsProviders",
    "layersCombo & Vision Adapter",
    "bar_chartUsage",
    "data_usageQuota Tracker",
    "savingsToken Saver"
  ]
}
```

The `Providers` navigation link was clicked successfully and loaded:

```text
URL: http://127.0.0.1:20129/dashboard/providers
Title: 9Router - AI Infrastructure Management
hasBody: true
```

The browser tab was released and the disposable server was stopped cleanly.

### 6. Linux VPS path

Deferred. This macOS environment has no disposable Linux VPS or maintenance-window VPS. The following were not claimed or simulated:

- `systemd-analyze verify` for the installed unit.
- Real VPS tag installation and service/health verification.
- Real VPS update to a second tag.
- Authenticated real VPS `/v1` smoke.
- Forced failed-health rollback with release/database restoration.

### 7. Accidental self-update path audit

Read-only search across `src`, `open-sse`, `cli`, `scripts`, and `deploy` for:

```text
npm i -g 9router@latest
registry.npmjs.org/9router
spawnUpdaterAndExit
```

Results:

- No `registry.npmjs.org/9router` occurrence.
- The `npm i -g 9router@latest` occurrences are preserved npm/desktop updater comments/configuration only (`src/lib/mitm/manager.js`, `src/shared/constants/config.js`, `cli/scripts/buildMitm.js`).
- `spawnUpdaterAndExit` has one import/use in `src/app/api/version/update/route.js` and one implementation in `src/lib/appUpdater.js`. The route checks `getUpdateSource(env)` and returns HTTP 409 before reaching the npm updater when `UPDATE_SOURCE=external`; focused tests and the authenticated production smoke verified this behavior.

### 8. Tracked diff audit

Read-only commands:

```text
git status --short
git diff --name-status
git diff --cached --name-status
git diff -- package.json cli/package.json
git diff --name-only -- .github deploy/systemd
git diff --unified=0 | grep -E 'npm (i|install) -g 9router@latest|spawnUpdaterAndExit|systemctl|timer|ExecStart' || true
```

Exact output was empty for all checks. There is no unintended package rename, GitHub Actions change, update timer change, privileged dashboard trigger change, or uncommitted tracked diff.

## Concerns

1. The brief's no-argument baseline command exits 2 because `tests/__baseline__/verify-no-regression.mjs` explicitly requires a results-file argument. Supplying the focused Vitest JSON results file passes with zero failures and no regressions. This was not changed because Task 5 prohibits implementation changes.
2. Linux `systemd` and real VPS install/update/rollback/authenticated `/v1` verification remain deferred, as required for this macOS environment.

## Report path

`.superpowers/sdd/task-5-report.md`
 
## Final verification rerun
 
This rerun inspected the complete diff from base `73d082a06bfc80b454a8493b0e1b0f2894d28260`. The working tree had no uncommitted changes; the branch diff contained only the intended deployment, external-update-mode, test, environment, service-unit, and runbook files (plus the existing ignored/scratch report artifacts).
 
### 1. Shell syntax
 
Command:
 
```text
bash -n deploy/github-deploy.sh
```
 
Exact result: no stdout/stderr; exit status `0`.
 
### 2. Focused tests
 
Command:
 
```text
cd tests && npx vitest run unit/external-update-mode.test.js unit/github-deploy-script.test.js
```
 
Exact output:
 
```text
 RUN  v4.1.11 /Users/glennpray/projects/9router/tests
 
 
 Test Files  2 passed (2)
      Tests  18 passed (18)
   Start at  14:13:31
   Duration  479ms (transform 244ms, setup 0ms, import 418ms, tests 89ms, environment 0ms)
 
 
 Wall time: 1.39 seconds
```
 
### 3. Production build
 
Command:
 
```text
npm run build
```
 
Exit status: `0`.
 
Exact decisive output:
 
```text
> 9router-app@0.5.69 build
> next build --webpack
 
▲ Next.js 16.3.4 (webpack)
✓ Compiled successfully in 8.8s
  Running TypeScript ...
  Finished TypeScript in 8ms ...
✓ Generating static pages using 7 workers (138/138) in 691ms
  Finalizing page optimization ...
  Collecting build traces ...
 
> 9router-app@0.5.69 postbuild
> node scripts/copy-standalone-assets.mjs
 
[standalone-assets] Copied static assets to /Users/glennpray/projects/9router/.next/standalone/.next/static
[standalone-assets] Copied public assets to /Users/glennpray/projects/9router/.next/standalone/public
[standalone-assets] Copied custom-server.js to /Users/glennpray/projects/9router/.next/standalone/custom-server.js
```
 
The build route table reported 138 generated static pages.
 
### 4. Baseline verifier
 
The focused Vitest JSON input was generated with:
 
```text
cd tests && npx vitest run unit/external-update-mode.test.js unit/github-deploy-script.test.js --reporter=json --outputFile=/tmp/9router-task5-final-results.json
```
 
Exact output:
 
```text
JSON report written to /tmp/9router-task5-final-results.json
```
 
Verifier command:
 
```text
node tests/__baseline__/verify-no-regression.mjs /tmp/9router-task5-final-results.json
```
 
Exact output:
 
```text
✅ No regression. (now fails=0, baseline known=24, all known)
```
 
### 5. Disposable production API smoke
 
The server was started from `.next/standalone/custom-server.js` with `UPDATE_SOURCE=external`, `NODE_ENV=production`, an isolated temporary `DATA_DIR`, a temporary environment file, and `PORT=20129`. The shared `9router-dev-ui` process on port 20128 was not stopped or restarted.
 
Exact API probes and results:

```text
curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:20129/api/version
{"updateSource":"external","currentVersion":"0.5.69","latestVersion":null,"hasUpdate":false,"managedExternally":true}
HTTP 200

curl -sS -o /tmp/9router-task5-final-update-unauth.txt -w 'HTTP %{http_code}\n' -X POST http://127.0.0.1:20129/api/version/update && cat /tmp/9router-task5-final-update-unauth.txt && rm -f /tmp/9router-task5-final-update-unauth.txt
HTTP 401
{"error":"Unauthorized"}

curl -sS -o /tmp/9router-task5-final-shutdown-unauth.txt -w 'HTTP %{http_code}\n' -X POST http://127.0.0.1:20129/api/version/shutdown && cat /tmp/9router-task5-final-shutdown-unauth.txt && rm -f /tmp/9router-task5-final-shutdown-unauth.txt
HTTP 401
{"error":"Unauthorized"}

curl -sS -c /tmp/9router-task5-final-cookies.txt -H 'Content-Type: application/json' -d '{"password":"task5-final-password"}' -w '\nHTTP %{http_code}\n' http://127.0.0.1:20129/api/auth/login
{"success":true,"mustChangePassword":false}
HTTP 200

curl -sS -b /tmp/9router-task5-final-cookies.txt -X POST -w '\nHTTP %{http_code}\n' http://127.0.0.1:20129/api/version/update
{"success":false,"message":"Updates are managed externally."}
HTTP 409

curl -sS -b /tmp/9router-task5-final-cookies.txt -X POST -w '\nHTTP %{http_code}\n' http://127.0.0.1:20129/api/version/shutdown
{"success":false,"message":"Shutdown is managed externally."}
HTTP 409
```
 
### 6. Disposable dashboard browser smoke
 
The headless browser opened `/dashboard`, authenticated with the temporary password, and observed:
 
```text
{
  "url": "http://127.0.0.1:20129/dashboard",
  "title": "9Router - AI Infrastructure Management",
  "hasNpmUpdateBanner": false,
  "hasInstallAction": false,
  "hasDashboardContent": true
}
```
 
The browser then clicked the normal `dns Providers` dashboard navigation link and loaded:
 
```text
{
  "url": "http://127.0.0.1:20129/dashboard/providers",
  "title": "9Router - AI Infrastructure Management",
  "hasBody": true
}
```
 
The managed browser tab was released and the disposable server was stopped with exit status `0`.
 
### 7. Cleanup evidence
 
Temporary directory, JSON results, cookie jar, and one-off unauthenticated response files were removed:
 
```text
rm -rf /tmp/9router-task5-final.E4iiPR /tmp/9router-task5-final-results.json /tmp/9router-task5-final-cookies.txt
test ! -e /tmp/9router-task5-final.E4iiPR && test ! -e /tmp/9router-task5-final-results.json && test ! -e /tmp/9router-task5-final-cookies.txt && ! lsof -nP -iTCP:20129 -sTCP:LISTEN
```
 
Exact cleanup result: no stdout/stderr; exit status `0`; no listener remained on port 20129.
 
### 8. Updater/CLI and accidental automation audit
 
Read-only searches found:
 
- No `registry.npmjs.org/9router` occurrence.
- `npm i -g 9router@latest` remains only in preserved npm/desktop updater comments/configuration (`src/lib/mitm/manager.js`, `src/shared/constants/config.js`, and `cli/scripts/buildMitm.js`).
- `spawnUpdaterAndExit` remains in the existing updater implementation and the existing npm update route; the route now checks `getUpdateSource(env)` first, and the external-mode focused tests plus authenticated smoke prove the external branch returns 409 before the updater call.
- `src/lib/appUpdater.js`, `src/shared/constants/config.js`, `cli/`, `cli/package.json`, root `package.json`, and `.github/` had no diff from the base.
- No update timer or CI workflow was added. The only `systemctl`/`ExecStart` diff is the intended deployment script and systemd unit.
 
### 9. Deferred checks
 
Linux-only verification remains deferred on macOS and is not claimed:
 
- `systemd-analyze verify` on the installed VPS unit.
- Real VPS install, service/health check, second-tag update, authenticated `/v1` request, and forced failed-health rollback/database restoration.

## Deployment-hardening rerun caveat

The final deployment hardening rerun was limited to the two commands permitted for this macOS workspace:

```text
$ bash -n deploy/github-deploy.sh
(no output; exit 0)

$ cd tests && npx vitest run unit/external-update-mode.test.js unit/github-deploy-script.test.js

 Test Files  2 passed (2)
      Tests  18 passed (18)
   Start at 15:04:07
   Duration 368ms (transform 191ms, setup 0ms, import 286ms, tests 53ms, environment 0ms)
```

The earlier API smoke excerpts above show the pre-hardening external 409 wording; the latest focused test validates the revised operator direction. The API/browser smoke was not rerun because the requested command allowance for this pass was limited to shell syntax and the two focused test files.

This rerun includes the updated external-mode 409 direction assertion and deployment source guards. It does not supersede the earlier build/API/browser evidence above, and no Linux/systemd lifecycle is claimed. Account/group creation, managed-path ownership, exact fixed-unit installation, stop-state confirmation, database rollback replacement, stable-release retention, and failed first-install cleanup remain Linux-only deferrals.

## Deployment edge-case completion evidence

Commands run exactly:

```text
$ bash -n deploy/github-deploy.sh
(no output; exit 0)

$ cd tests && npx vitest run unit/external-update-mode.test.js unit/github-deploy-script.test.js
 RUN  v4.1.11 /Users/glennpray/projects/9router/tests

 Test Files  2 passed (2)
      Tests  19 passed (19)
```

The focused assertions now include setup ordering, regular-unit cleanup, confirmed-stop and database-directory safety, release/failed-artifact retention, fixed-unit validation, external 409 guidance, and JSON health-loop requirements. No formatter, linter, project-wide suite, or real lifecycle command was run.

Retention explicitly excludes all `.failed-*` release directories before matching stable tags, so failed prerelease artifacts are preserved as required.

Linux-only deferrals: root/systemd lifecycle and stop-state failure injection; service-account/group and runuser transitions; exact-tag GitHub fetch/build; fixed-unit installation; database backup/restore and atomic symlink switching; retention and first-install rollback failures; and VPS health verification.

## Final correction evidence

Commands run exactly:

```text
$ bash -n deploy/github-deploy.sh
(no output; exit 0)

$ cd tests && npx vitest run unit/external-update-mode.test.js unit/github-deploy-script.test.js

 RUN  v4.1.11 /Users/glennpray/projects/9router/tests


 Test Files  2 passed (2)
      Tests  20 passed (20)
   Start at  15:19:03
   Duration  355ms (transform 181ms, setup 0ms, import 278ms, tests 53ms, environment 0ms)
```

The final correction sets `/var/lib/9router/db` to `root:9router` mode `0770` while retaining root-owned deployment, update, runtime, and backup boundaries and `0700` runtime/backup directories. Rollback database mutation remains gated by successful stop plus confirmed `inactive`/`failed` state. Update rollback restores `current` whenever the previous release is validated, preserves a promoted candidate without renaming an active target, and keeps failure status/current-tag/transaction state coherent. First-install unit, enablement, current-link, and newly-created database cleanup is gated on a safe stop so a failed stop remains retryable.

## Linux-only deferrals

No real Linux lifecycle was run. Deferred checks require a disposable Linux VPS: account/group and root/systemd transitions; exact-tag GitHub fetch/build and service-unit installation; stop failure and `ActiveState` injection; runuser ownership; no-follow database backup/restore; atomic current-link rollback; failed-candidate preservation on failed stop; first-install cleanup/retry paths; retention failure rollback; and service health verification.
