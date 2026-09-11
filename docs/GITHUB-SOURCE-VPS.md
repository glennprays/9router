# Manual GitHub-Source VPS Deployment

This runbook installs 9Router from a tagged GitHub source checkout on a Debian or Ubuntu VPS. The VPS builds the release locally and runs the generated standalone server under systemd. Releases are selected manually; there is no GitHub polling, update timer, CI/CD deployment, or npm package installation involved.

The deployment script is deliberately run as root because it creates `/opt/9router`, `/var/lib/9router`, `/etc/9router`, the `9router` service account, and the systemd unit. The application itself runs as the unprivileged `9router` user.

## Operating model and paths

The deployment script stages each release in a separate directory, builds it, and then switches an atomic symlink:

```text
/opt/9router/
├── current -> /opt/9router/releases/v0.5.70
├── releases/
│   ├── v0.5.69/
│   └── v0.5.70/
└── update/
    ├── deploy.lock
    ├── status.json
    └── failure-*.log
```

The systemd unit runs `/opt/9router/current/.next/standalone/custom-server.js` with:

- `User=9router` and `Group=9router`
- `WorkingDirectory=/opt/9router/current`
- `/etc/9router/9router.env` as its environment file
- `PORT=20128`; this port is fixed because the deployment script's health URL is fixed at `http://127.0.0.1:20128/api/health`
The systemd unit requires an executable `/usr/bin/node` because its `ExecStart` uses that absolute path; a different `node` found on `PATH` is not sufficient.

Persistent application data is outside the release tree at `/var/lib/9router`, including the SQLite database at `/var/lib/9router/db/data.sqlite` and deployment backups at `/var/lib/9router/backups/`. Keep `/var/lib/9router` when removing or replacing releases.

## Prerequisites

Use a supported Debian or Ubuntu VPS and a dedicated host or VM. Install or verify all of the following before running the deployment script:

- Node.js 22 and its matching `npm` command
- Git
- `curl`
- systemd (including `systemctl` and `journalctl`)
- A compiler toolchain for optional native dependencies (for Debian/Ubuntu, typically `build-essential`, Python, and a working C/C++ compiler)
- OpenSSL, used below to generate secrets
- A reverse proxy such as nginx, Caddy, or an equivalent service for public HTTPS termination

The reverse proxy should be the public entry point for `/dashboard` and `/v1`. Do not expose the application port directly to the Internet unless the host firewall and your threat model explicitly require it. The local health check uses `http://127.0.0.1:20128/api/health`.

The VPS does **not** need an npm publication of this project. npm is nevertheless required on the VPS: the deployment script runs `npm ci` to install the tagged checkout's locked dependencies and `npm run build` to produce the standalone application before it starts systemd.

Before continuing, confirm the tools resolve to the intended system installations:

```bash
node --version       # Node.js 22.x
npm --version
git --version
curl --version
systemctl --version
openssl version
```

## Create the environment file

Create the environment file before the first install. Generate long random values; do not reuse provider keys, passwords, or secrets from another host. The command prints only the initial dashboard password so it can be recorded in a password manager. The file itself is restricted to root.

```bash
sudo install -d -m 0755 /etc/9router
sudo bash -c '
  set -eu
  umask 077
  initial_password="$(openssl rand -hex 24)"
  cat > /etc/9router/9router.env <<EOF
JWT_SECRET=$(openssl rand -hex 32)
INITIAL_PASSWORD=${initial_password}
API_KEY_SECRET=$(openssl rand -hex 32)
MACHINE_ID_SALT=$(openssl rand -hex 32)
DATA_DIR=/var/lib/9router
PORT=20128
NODE_ENV=production
UPDATE_SOURCE=external
EOF
  chmod 0600 /etc/9router/9router.env
  printf "Record INITIAL_PASSWORD securely: %s\\n" "$initial_password" >&2
'
```

`UPDATE_SOURCE=external` is required for this deployment. It tells the application that releases are managed by the operator and the external deployment script, not by the application’s npm updater. The deployment script checks this value before changing releases. On later installs or updates, it preserves `/etc/9router/9router.env` byte-for-byte; it does not regenerate or overwrite secrets.

Check the file without printing its secret values into a shared terminal or log:

```bash
sudo stat -c '%a %U:%G %n' /etc/9router/9router.env
sudo grep -E '^(DATA_DIR|PORT|NODE_ENV|UPDATE_SOURCE)=' /etc/9router/9router.env
```

## Safely obtain and review a deployment script

Choose one release tag and use that same tag for the script URL and the deployment command. Release tags must match the script's accepted `vMAJOR.MINOR.PATCH` form, optionally with a prerelease suffix. Do not download a moving branch and pipe it into a privileged shell.

For the first install, the approved tag-pinned sequence is:

```bash
curl -fsSLo /tmp/9router-deploy-v0.5.70.sh \
  https://raw.githubusercontent.com/glennprays/9router/v0.5.70/deploy/github-deploy.sh
less /tmp/9router-deploy-v0.5.70.sh
sudo bash /tmp/9router-deploy-v0.5.70.sh install --tag v0.5.70
```

Review the downloaded script before running it. Confirm that it accepts only `install` and `update`, requires an exact release tag, clones the exact repository `https://github.com/glennprays/9router.git` by default, and permits `NINEROUTER_REPOSITORY_URL` only when it matches the validated HTTPS form `https://github.com/<owner>/<repo>.git`. Also confirm that it uses the expected `/opt/9router` and `/var/lib/9router` paths, runs `npm ci` and `npm run build` before switching `current`, installs the checked-in systemd unit, and performs a health check. If the project publishes a trusted checksum for the selected tag, compare it independently before executing the script:

```bash
sha256sum /tmp/9router-deploy-v0.5.70.sh
```

Do **not** use this unsafe pattern:

```bash
curl -fsSL https://raw.githubusercontent.com/glennprays/9router/master/deploy/github-deploy.sh | sudo bash
```

A branch such as `master` moves over time. Piping it directly to `sudo bash` gives the reviewer no opportunity to inspect the exact bytes and allows a later branch change to alter a root command without changing the command shown in an operations record. Download a script at the same immutable release tag as the application, inspect it, and then invoke the local file.

## First installation

The tag-pinned command above performs the first installation. In detail, it:

1. Creates the `9router` system account and deployment directories.
2. Clones the selected tag to `/opt/9router/releases/<tag>`.
3. Runs `npm ci` and `npm run build` in that tagged checkout.
4. Installs `deploy/systemd/9router.service` at `/etc/systemd/system/9router.service` and reloads systemd.
5. Atomically creates `/opt/9router/current` pointing at the built release.
6. Enables and starts `9router.service`.
7. Waits for `/api/health` to return HTTP 200 with `{ "ok": true }`.

If the environment file is missing or does not contain the required `DATA_DIR=/var/lib/9router` and `UPDATE_SOURCE=external` lines, the script stops before changing releases. If cloning or building fails, the active release and `current` symlink are left untouched.

## Verify the running release

Run the required service and application checks after install and after every update:

```bash
test -x /usr/bin/node
sudo systemctl status 9router
sudo journalctl -u 9router -n 100 --no-pager
health_ok=0
for attempt in $(seq 1 30); do
  if health_json="$(curl --fail --silent http://127.0.0.1:20128/api/health)" \
    && /usr/bin/node -e 'const value = JSON.parse(process.argv[1]); process.exit(value.ok === true ? 0 : 1);' "$health_json"; then
    health_ok=1
    break
  fi
  [ "$attempt" -eq 30 ] || sleep 1
done
test "$health_ok" -eq 1

The health response must indicate `ok: true`. Also test the public HTTPS reverse-proxy URL from a client that can reach the VPS:

- `/dashboard` serves the dashboard from the current GitHub-built release.
- `/v1` serves the OpenAI-compatible API from the same release.
- The reverse proxy presents the public TLS certificate and forwards only the intended paths and headers.

In external mode, the dashboard reports that updates are managed externally and does not offer the upstream npm updater. The dashboard's application update endpoint and application shutdown endpoint are blocked in this mode; use systemd and the deployment script for lifecycle operations.

For deployment metadata and failures, inspect the files written under `/opt/9router/update/`:

```bash
sudo cat /opt/9router/update/status.json
sudo ls -l /opt/9router/update/
```

## Manual updates

Updates are explicit operator actions. Select and review the new tag's deployment script, then run `update` with that exact tag. For example:

```bash
curl -fsSLo /tmp/9router-deploy-v0.5.71.sh \
  https://raw.githubusercontent.com/glennprays/9router/v0.5.71/deploy/github-deploy.sh
less /tmp/9router-deploy-v0.5.71.sh
sudo bash /tmp/9router-deploy-v0.5.71.sh update --tag v0.5.71
```

The update stages `/opt/9router/releases/v0.5.71` and builds it before stopping the service. It then stops `9router.service`, backs up `/var/lib/9router/db/data.sqlite` under `/var/lib/9router/backups/`, switches `/opt/9router/current` atomically, starts the service, and performs the local health check. A deployment lock prevents concurrent updates. On a successful update, retention leaves only the current and previous release; older rollback requires a new explicit tagged deployment.

There is no automatic GitHub polling, systemd update timer, CI/CD deployment, or background release watcher. Schedule or execute this command through your own reviewed operational process if you need a maintenance window, but keep the tag explicit and review the script first.

## Rollback

### Automatic rollback after a failed update

If the newly started release fails its health check, the deployment script stops the service, restores the previous `current` target atomically, restores the database backup made for that update, starts the previous service, and reports a failure. The failed release directory is preserved after the switch so it can be inspected. Build failures that happen before the switch clean up the unactivated candidate and never disturb the active release.

Inspect the failure record and service journal before retrying:

```bash
sudo cat /opt/9router/update/status.json
sudo journalctl -u 9router -n 200 --no-pager
```

Do not delete the failed release until its logs and build output have been collected. Fix the cause or choose a known-good tag before attempting another update.

### Operator-selected release rollback

To restore a retained release after a successful update, first identify the release directory and stop the service. Back up the current database before changing it. The symlink replacement below uses a temporary link and `mv -Tf` so readers see either the old or new complete target, never a partially constructed link.

```bash
# Replace v0.5.70 with the retained known-good release.
GOOD_TAG=v0.5.70

sudo test -d "/opt/9router/releases/${GOOD_TAG}"
sudo systemctl stop 9router
sudo cp --preserve=mode,ownership \
  /var/lib/9router/db/data.sqlite \
  "/var/lib/9router/backups/manual-rollback-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
sudo rm -f /opt/9router/current.rollback
sudo ln -s -- "/opt/9router/releases/${GOOD_TAG}" /opt/9router/current.rollback
sudo mv -Tf -- /opt/9router/current.rollback /opt/9router/current
sudo systemctl start 9router
health_ok=0
for attempt in $(seq 1 30); do
  if health_json="$(curl --fail --silent http://127.0.0.1:20128/api/health)" \
    && /usr/bin/node -e 'const value = JSON.parse(process.argv[1]); process.exit(value.ok === true ? 0 : 1);' "$health_json"; then
    health_ok=1
    break
  fi
  [ "$attempt" -eq 30 ] || sleep 1
done
test "$health_ok" -eq 1

If the release changed the database schema or data format, restore the backup created before that update while the service is stopped. Use the backup corresponding to the update tag; deployment backups have names like `/var/lib/9router/backups/20260911T120000Z-v0.5.71.sqlite`.

```bash
sudo systemctl stop 9router
sudo cp --preserve=mode,ownership \
  /var/lib/9router/backups/<pre-update-timestamp>-v0.5.71.sqlite \
  /var/lib/9router/db/data.sqlite
sudo chown 9router:9router /var/lib/9router/db/data.sqlite
sudo chmod 0600 /var/lib/9router/db/data.sqlite
sudo systemctl start 9router
health_ok=0
for attempt in $(seq 1 30); do
  if health_json="$(curl --fail --silent http://127.0.0.1:20128/api/health)" \
    && /usr/bin/node -e 'const value = JSON.parse(process.argv[1]); process.exit(value.ok === true ? 0 : 1);' "$health_json"; then
    health_ok=1
    break
  fi
  [ "$attempt" -eq 30 ] || sleep 1
done
test "$health_ok" -eq 1
```

If a rollback does not pass the health check, stop the service and inspect `journalctl` before making another release switch. Never remove `/var/lib/9router` as part of release cleanup.

## npm and update boundaries

- npm is a VPS build tool in this deployment. The release script uses `npm ci` and `npm run build` inside the tagged source checkout; no npm publication is required.
- `npm update` inside the source checkout updates dependency versions and the lockfile. It does **not** update tracked application source, and it is not the supported release operation here. Use a clean immutable tag and `npm ci` instead of mutating a deployed checkout.
- `npm i -g 9router@latest` is an explicit upstream npm installation. It is not used by this GitHub-source deployment and must not be used as a substitute for the tag-pinned script.
- `UPDATE_SOURCE=external` blocks the application's npm update and shutdown endpoints. Stop, start, update, and rollback through systemd and the reviewed deployment script.
- This deployment performs no automatic GitHub polling and has no CI/CD or timer-based update path. A new release is installed only when an operator explicitly downloads and reviews its tag-pinned script and runs `install` or `update`.

## Security checklist

- Use a protected VPS account with SSH keys and least-privilege sudo; do not expose SSH passwords or the environment file.
- Keep `/etc/9router/9router.env` mode `0600`, and rotate its secrets through a planned maintenance procedure if they are exposed.
- Do not run a moving `master` deployment script as root, and never pipe an unreviewed download to `sudo bash`.
- Review every release script and use the same exact tag in the raw URL, local filename, and `--tag` argument.
- Keep the Node service unprivileged as `9router`; only the deployment operation requires root.
- Terminate public HTTPS at a maintained reverse proxy, restrict the application port with the firewall, and preserve the local-only health check.
- Retain only the current and previous release after successful deployment; restoring an older rollback target requires a new explicit tagged deployment.
