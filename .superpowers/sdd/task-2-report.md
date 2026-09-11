# Task 2 report: tag-pinned GitHub deployment

## RED evidence

Added `tests/unit/github-deploy-script.test.js` before the production script. The focused run failed because `deploy/github-deploy.sh` did not exist; the invalid-tag assertions consequently observed exit code 127 instead of the required 2.

## GREEN evidence

- `bash -n deploy/github-deploy.sh` passed.
- `cd tests && npx vitest run unit/github-deploy-script.test.js` passed: 1 file, 2 tests.
- Manual smoke check confirmed `--help` prints both install/update forms and `update --tag master` exits 2 before root/prerequisite operations.

## Changed files

- `deploy/github-deploy.sh`: manual root-only installer/updater with exact tag and repository validation, environment guard, staged clone/build, systemd lifecycle, SQLite backup, atomic symlink switching, health validation, rollback, retention, lock handling, and sanitized status/failure records.
- `tests/unit/github-deploy-script.test.js`: non-root help and invalid-tag argument coverage.

## Self-review

- Help is handled before root and prerequisite checks.
- Tag validation is anchored to the required release-tag expression; branch names and traversal strings are rejected with status 2.
- Repository overrides are restricted to the required HTTPS GitHub `.git` form.
- Git, npm, curl, systemctl, node, and readlink paths are resolved once and invoked with separate arguments; no `eval`, `sh -c`, or `bash -c` is used.
- Candidate cleanup is limited to newly cloned candidates on clone/build failure; candidates switched into `current` are retained for service/health diagnosis and rollback.
- Status and failure records contain fixed phase/error values, validated tags, and timestamps only; environment values and command output are not recorded.
- Update locking is acquired with `mkdir` and released by the exit trap.

## Concerns

- Full install/update execution requires a Linux VPS with root, systemd, the configured service unit, and a reachable tagged GitHub repository; those paths were intentionally not exercised in the focused non-root test run.
- The report is intentionally left outside the Task 2 implementation commit because the brief's commit scope names only the script and focused test.

## Review fixes

### Fixed RED evidence

After adding the positive valid-tag assertion and before fixing the production script, the focused test command:

```bash
cd tests && npx vitest run unit/github-deploy-script.test.js
```

failed with `1 failed` and `2 passed`. The new `v0.5.70` case exited with status `2`, but stderr was `github-deploy: tag must be a release tag such as v0.5.70` instead of the expected root-related error, proving the Bash PCRE pattern rejected a valid tag.

### Fixed GREEN evidence

- Replaced the Bash-incompatible `(?:...)` tag group with the POSIX ERE `(-...)?` equivalent. `cd tests && npx vitest run unit/github-deploy-script.test.js` passed: `1 file, 3 tests`.
- Added the `deployment_started` gate to the EXIT failure status/log path, set immediately before install/update execution. Argument-validation exits therefore leave any existing status record unchanged and do not create a failure log; failures after dispatch retain failure reporting.
- `bash -n deploy/github-deploy.sh` passed with no output.

## Final-review fixes

### RED evidence

Added a focused non-root assertion that `UPDATE_ROOT`, `DATA_DIR`, and `ENV_FILE` process-environment overrides are rejected before the root guard. Before the script fix:

```text
FAIL unit/github-deploy-script.test.js > GitHub deployment script arguments > rejects deployment path overrides before the root guard
expected stderr containing "path overrides", received "github-deploy: install and update require root"
```

### GREEN evidence

- `bash -n deploy/github-deploy.sh` passed.
- `cd tests && npx vitest run unit/github-deploy-script.test.js` passed: `1 file, 4 tests`.
- Focused tests cover help, branch/path-traversal rejection, valid-tag parsing before the root guard, and all three deployment-path override rejections.
- No real install or update path was executed on macOS.

### Implemented review fixes

- Same-tag update returns unchanged after canonical current/tag validation and before staging, npm, or build work; every different tag gets a fresh unprivileged staging checkout.
- Clone, `npm ci`, and `npm run build` run as `9router`; successful candidates are root-owned and service-account-readable before activation.
- Deployment paths are fixed to the checked-in systemd paths; process overrides are rejected.
- `current` is resolved with `readlink -f` and must be a direct child of `/opt/9router/releases`.
- `/usr/bin/node` and `/usr/bin/npm` are required and used; health polling uses bounded curl/sleep time within 30 seconds.
- Environment files reject symlinks, non-root ownership/group, non-0600 modes, duplicate targeted assignments, and mismatched effective `DATA_DIR`, `PORT`, or `UPDATE_SOURCE` values.
- Git fetches and detached-checkouts use the exact `refs/tags/<tag>` ref rather than `--branch`.
- The failure trap covers the complete update stop-through-start transaction and restores the previous symlink/database before restarting it, while retaining failure logs.
- `install` rejects an existing `current` deployment or installed/enabled/active service.

### Deferred Linux-only verification

Root/systemd execution, `runuser` ownership transitions, exact-tag fetches against GitHub, service-unit installation, database backup/restore, atomic symlink switching, and 30-second health rollback remain unverified on this macOS host. They require a disposable Linux VPS with the checked-in systemd unit and a reachable tagged repository.

## Residual blocker fixes

- Kept `transaction_active=1` through retention and the successful status write; failures in either operation remain eligible for rollback and restart of the previous service.
- Isolated both npm commands with `runuser -u 9router`, `env -i`, a 9router-owned `HOME` and npm cache, `/dev/null` global npm config, and `PATH=/usr/bin:/bin`.
- Made install reject every service-unit filesystem entry, including dangling symlinks, and changed the systemd probe to accept only an explicit `LoadState=not-found`; query failures now fail closed.
- Reworked health polling around a millisecond deadline, passing the exact remaining duration to curl and bounding sleeps to the remaining deadline.
- Added deterministic focused assertions for repository validation, install/systemd guards, transaction ordering, npm environment isolation, and subsecond health timeout wiring.

## Verification evidence

`bash -n deploy/github-deploy.sh` produced no output and exited successfully.

`cd tests && npx vitest run unit/github-deploy-script.test.js`:

```text
 RUN  v4.1.11 /Users/glennpray/projects/9router/tests

 Test Files  1 passed (1)
 Tests  7 passed (7)
 Start at  13:59:39
 Duration  137ms (transform 8ms, setup 0ms, import 14ms, tests 42ms, environment 0ms)
```

No real root, systemd, GitHub, service, or Linux runtime lifecycle was executed on macOS.

## Deferred Linux-only checks

Root/systemd execution, `systemctl show` behavior for absent/loaded/manager-failure states, `runuser` ownership transitions, npm cache and lifecycle execution as `9router`, exact-tag fetches against GitHub, service-unit installation, database backup/restore, atomic symlink switching, millisecond health timeout behavior, retention failure rollback, successful-status-write failure rollback, and 30-second health rollback remain unverified on this macOS host. They require a disposable Linux VPS with the checked-in systemd unit, a reachable tagged repository, and controlled failure injection for the rollback cases.

## Re-review completion evidence

The six focused re-review findings are addressed in the current implementation:

1. `transaction_active` stays set across retention and the successful status write, and is cleared only after `write_status true ""` returns successfully. Failures in either operation therefore enter the EXIT rollback path and restart the previous service.
2. Both `npm ci` and `npm run build` execute as `9router` through `env -i`, with `HOME` and npm cache paths under the 9router-owned runtime directory, isolated npm config paths, and `PATH=/usr/bin:/bin`. The systemd lifecycle continues to use `/usr/bin/node`.
3. Install rejects both existing service-unit targets and dangling symlinks with `[[ ! -e ... && ! -L ... ]]`.
4. Install service probing accepts only successful `systemctl show ... LoadState` output equal to `not-found`; query/manager errors and every other state fail closed.
5. Health polling uses monotonic `/proc/uptime` milliseconds, passes the exact remaining duration to curl, and limits subsecond sleeps to the remaining deadline. `HEALTH_TIMEOUT_MS=30000` documents and enforces the 30-second maximum.
6. Focused source guards cover systemd absence probing, dangling-unit rejection, transaction ordering, isolated npm environments, monotonic deadline wiring, and removal of the old `is-active`/`is-enabled` absence probe.

Exact verification commands and results:

```text
$ bash -n deploy/github-deploy.sh
(no output; exit 0)

$ cd tests && npx vitest run unit/github-deploy-script.test.js
 RUN  v4.1.11 /Users/glennpray/projects/9router/tests

 Test Files  1 passed (1)
      Tests  7 passed (7)
```

## Deferred Linux-only checks

No real install/update lifecycle was attempted on macOS. A disposable Linux systemd VPS is still required to verify root/systemd behavior, `systemctl show` absent/loaded/manager-error states, runuser ownership and npm lifecycle execution, exact-tag GitHub fetch/build, service installation and restart, database backup/restore, atomic symlink switching, retention failure rollback, successful-status-write failure rollback, and the hard 30-second health timeout under controlled failure injection.

## Final hardening rerun

### GREEN/check evidence

Commands run exactly as requested:

```text
$ bash -n deploy/github-deploy.sh
(no output; exit 0)

$ cd tests && npx vitest run unit/external-update-mode.test.js unit/github-deploy-script.test.js

 RUN  v4.1.11 /Users/glennpray/projects/9router/tests

 Test Files  2 passed (2)
      Tests  18 passed (18)
   Start at 15:04:07
   Duration 368ms (transform 191ms, setup 0ms, import 286ms, tests 53ms, environment 0ms)
```

The external-mode assertion now verifies the HTTP 409 directs operators to the reviewed tag-pinned deployment script and `update --tag`.

### Implemented final review fixes

- Stop rollback requires both successful `systemctl stop` and a successful `systemctl show ActiveState` query returning `inactive` or `failed`; database restore/deletion is guarded by that confirmation and known safe database state.
- Database state is captured and validated before stopping, revalidated after stopping, and restored through a root-created temporary file with ownership/mode set before atomic `mv -Tf`.
- Managed directory ancestors are checked in order for symlinks/non-directories before account or directory mutation; deployment parents and backup storage are root-owned, while only the database directory is service-owned.
- First-install post-switch failures are transactional: unit enablement/current/database cleanup occurs only under safe stop confirmation, and failed promoted releases are preserved as `<tag>.failed-<timestamp>-<pid>`.
- Successful releases use stable `/opt/9router/releases/<tag>` paths; retention keeps current/previous stable tags and the current rollback backup while preserving manual backups and failed artifacts.
- The service account uses a matching `9router` group, and the runtime unit is installed only after exact fixed-content validation.
- Runbook health loops require HTTP success and JSON `ok === true` using `/usr/bin/node`.

### Linux-only deferrals

No root/systemd lifecycle was attempted on macOS. VPS verification of account/group transitions, directory ownership, exact-tag fetch/build, service-unit installation, stop-state behavior, atomic database restoration, retention failure rollback, and first-install transaction cleanup remains deferred to a disposable Linux host.

## Deployment edge-case completion evidence

Commands run for this implementation:

```text
$ bash -n deploy/github-deploy.sh
(no output; exit 0)

$ cd tests && npx vitest run unit/external-update-mode.test.js unit/github-deploy-script.test.js
 RUN  v4.1.11 /Users/glennpray/projects/9router/tests

 Test Files  2 passed (2)
      Tests  19 passed (19)
```

Focused source assertions cover setup-before-database-capture ordering, regular-unit cleanup, confirmed-stop database guards, writable service-owned database directory, root-owned runtime/backup/deployment parents, stable and failed release naming/preservation, fixed-unit comparison/install content, external route guidance, and all three runbook JSON health loops.

The final retention guard explicitly skips every `.failed-*` directory before applying the stable-tag matcher, including prerelease-tag failure names.


## Final correction evidence

Implemented the remaining deployment corrections:

- `/var/lib/9router/db` remains `9router:9router` and is now mode `0770`, while deployment, update, runtime, and backup parent boundaries remain root-owned; runtime and backup directories remain `0700`, and database/backups retain no-follow checks.
- `rollback_update` mutates the database only when `systemctl stop` succeeds and `ActiveState` is confirmed `inactive` or `failed`. A failed stop leaves database state untouched.
- `rollback_update` restores the previous `current` symlink independently of stop success when the previous release is still a validated direct child. It does not rename a promoted release while `current` still targets it, preventing a dangling symlink; rollback failures remain reported as `rollback-failed`.
- `rollback_first_install` removes enablement, the regular unit, `current`, and a newly-created database only after the service is safely stopped. Stop failure leaves lifecycle state intact for retry, while the promoted artifact remains available for diagnosis.
- `currentTag`, `current_switched`, `release_promoted`, and `transaction_active` transitions now reflect restored, retained, or unresolved release state on both stop outcomes.

Exact verification:

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

## Linux-only deferrals

No real Linux lifecycle was run. The following remain deferred to a disposable Linux VPS: root/systemd account and unit transitions; stop-command failure and `ActiveState` confirmation injection; `runuser` ownership transitions; exact-tag fetch/build; service-unit installation; no-follow database backup/restore; atomic symlink switching and rollback; failed-candidate preservation under stop failure; retention and first-install cleanup failure/retry paths; and VPS health verification.
## EXIT-trap and rollback hardening evidence

Commands run exactly:

```text
$ bash -n deploy/github-deploy.sh
(no output; exit 0)

$ cd tests && npx vitest run unit/external-update-mode.test.js unit/github-deploy-script.test.js
 RUN  v4.1.11 /Users/glennpray/projects/9router/tests

 Test Files  2 passed (2)
      Tests  21 passed (21)
   Start at 15:40:48
   Duration 366ms (transform 191ms, setup 0ms, import 292ms, tests 62ms, environment 0ms)
```

The focused source assertion now proves the EXIT trap initializes `rollback_result=0`, invokes the selected rollback through an `|| rollback_result=$?` guard, and continues to failed-release preservation, failure-log/status writing, and lock release. Rollback symlink restoration now creates `current.new` and replaces `current` with `mv -Tf` without first removing `current`; the previous target remains constrained to a validated direct child of the managed releases directory. Database `stat %F` parsing is locale-pinned with `LC_ALL=C`. The runbook verification and manual rollback health loops now close before the database restore block. Reported database ownership matches the implementation: `9router:9router`.

Linux/systemd lifecycle, rollback failure injection, atomic symlink behavior on the target VPS, locale behavior on the target distribution, and database restore execution remain deferred; only the requested shell syntax and focused macOS tests were run.
## Final-review findings round (four findings)

### Fixes

1. Blocker: both tag-verification calls (`git rev-parse HEAD` and `git rev-parse refs/tags/<tag>^{commit}`) now run through `"$RUNUSER_BIN" -u 9router --`, matching the init/remote/fetch/checkout calls, so verification executes as the checkout owner inside the 9router-owned candidate before the root chown. The `[[ "$head_commit" == "$tag_commit" ]]` equality check and the fixed `/usr/bin/git` and `/usr/sbin/runuser` binary paths are unchanged.
2. `atomic_switch_to` guards both swap steps: `"$LN_BIN" -s ... || return 1` and `"$MV_BIN" -Tf ... || return 1`. A failed swap can no longer fall through to `current_switched=1` or report success; callers keep their existing `|| fail` handling of the function result.
3. `stop_service_confirmed` sets `stop_confirmation_failed=0` on entry, so every attempt is evaluated independently. A second, successful stop during EXIT-trap rollback no longer inherits a stale failure flag, preventing rollback from wrongly reporting rollback-failed and skipping restart/restore.
4. `resolve_current_target` and `resolve_current_tag` no longer call `fail` inside what was a command-substitution subshell (which swallowed the specific `failure_code`). They set `failure_code` to `current-release-missing`/`current-release-invalid` and return nonzero; `update_release` invokes them in the parent shell with `|| fail "$failure_code"`, so `status.json` and the failure log now record the specific code instead of generic `deployment-failed`. Resolution output is captured through the new `resolved_current_target`/`resolved_current_tag` globals.

### Local mechanism repro (macOS, no Linux lifecycle)

Dubious-ownership mechanism, mirroring root rev-parse in a non-root-owned checkout:

```text
$ GIT_TEST_ASSUME_DIFFERENT_OWNER=1 /usr/bin/git rev-parse HEAD
fatal: detected dubious ownership in repository at '/Users/glennpray/projects/9router'
(exit 128)
```

The identical `git -C <repo> rev-parse HEAD` run as the checkout owner exits 0; `runuser -u 9router --` reproduces that owner path on Linux.

Command-substitution failure-code mechanism, under `set -Eeuo pipefail` with an EXIT trap:

```text
OLD pattern (v="$(resolver)" where the resolver exits 1):
OLD trap records error: deployment-failed

NEW pattern (resolver sets failure_code and returns 1; parent runs resolver || fail "$failure_code"):
github-deploy: current-release-missing
NEW trap records error: current-release-missing
```

### Focused test additions

`tests/unit/github-deploy-script.test.js` gained one deterministic source assertion block, `it("verifies tags as the checkout owner and fails switch and resolution closed")`, covering: both rev-parse calls routed through `"$RUNUSER_BIN" -u 9router -- "$GIT_BIN"` (and no bare `$GIT_BIN` `head_commit` capture), the preserved commit-equality check, `|| return 1` on both `ln` and `mv` inside `atomic_switch_to` with `current_switched=1` ordered after the swap, `stop_confirmation_failed=0` placed before the `systemctl stop` in `stop_service_confirmed`, and parent-shell `|| fail "$failure_code"` resolution with both specific codes set via `return 1` (no `fail "current-release-missing"` and no `previous_target="$(resolve_current_target)"` subshell capture remaining).

### Verification evidence

```text
$ bash -n deploy/github-deploy.sh
(no output; exit 0)

$ cd tests && npx vitest run unit/external-update-mode.test.js unit/github-deploy-script.test.js
 RUN  v4.1.11 /Users/glennpray/projects/9router/tests

 Test Files  2 passed (2)
      Tests  22 passed (22)
   Start at  16:29:25
   Duration  353ms (transform 181ms, setup 0ms, import 284ms, tests 54ms, environment 0ms)
```

### Linux-only deferrals

`runuser` execution as the service account, root-versus-owner `git rev-parse` against the real staged candidate, real `ln -s`/`mv -Tf` swap atomicity, `systemctl` stop/restart confirmation with the reset confirmation flag, and the end-to-end update rollback remain deferred to a disposable Linux VPS. Only shell syntax, the focused macOS suites, and the local semantic repros above were exercised.
