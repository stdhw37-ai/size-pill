#!/usr/bin/env bash
set -Eeuo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
project_dir="$(pwd -P)"

# Serialize cleanup/build, but release the lock before the foreground server starts.
mkdir -p .wrangler
exec 9>.wrangler/start-codespace.lock
flock -n 9 || { echo 'Another Codespace startup is already in progress.' >&2; exit 1; }

echo 'Checking this project for existing Wrangler/workerd dev processes...'
node --input-type=module <<'NODE'
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createServer } from 'node:net';

const root = process.cwd();
function devProcess(pid) {
  try {
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    if (cwd !== root && !cwd.startsWith(root + sep)) return false;
    const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const executable = basename(readlinkSync(`/proc/${pid}/exe`));
    const wrangler = executable === 'node' && args.slice(1, 3).some(arg =>
      /(?:^|\/)wrangler\/(?:bin\/wrangler|wrangler-dist\/cli)\.js$/.test(arg) ||
      /(?:^|\/)\.bin\/wrangler$/.test(arg));
    return (wrangler && args.includes('dev')) ||
      (executable === 'workerd' && args[1] === 'serve');
  } catch { return false; } // Process may have exited during inspection.
}
const pids = readdirSync('/proc').filter(pid => /^\d+$/.test(pid) && devProcess(pid));
function stop(pid, signal) {
  if (!devProcess(pid)) return;
  try { process.kill(Number(pid), signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
if (pids.length) {
  console.log(`Stopping dev processes: ${pids.join(', ')}`);
  for (const pid of pids) stop(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 50 && pids.some(devProcess); attempt++) await setTimeout(100);
  for (const pid of pids) stop(pid, 'SIGKILL');
  for (let attempt = 0; attempt < 20 && pids.some(devProcess); attempt++) await setTimeout(100);
} else {
  console.log('No existing project dev processes.');
}
// Do not kill an unrelated service or silently move to another port.
await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', error => reject(new Error(`Cannot bind 0.0.0.0:8787 (${error.code}); check port availability and permissions.`)));
  server.listen(8787, '0.0.0.0', () => server.close(resolve));
});
NODE

if [[ ! -x node_modules/.bin/wrangler ]]; then
  npm ci
fi
npm run build

if [[ -n "${CODESPACE_NAME:-}" ]]; then
  command -v gh >/dev/null || { echo 'GitHub CLI (gh) is required in Codespaces.' >&2; exit 1; }
  echo 'Registering Codespaces port 8787 as Private...'
  # Explicitly enforce private even if a previous session changed visibility.
  # Fail before serving if the Codespaces port configuration cannot be updated.
  gh codespace ports visibility 8787:private -c "$CODESPACE_NAME"
fi

# Print the clickable URL only after the app is ready. Wrangler stays in the
# foreground via exec, so Ctrl+C and terminal shutdown reach the dev server.
startup_pid=$$
(
  exec 9>&-
  for ((attempt = 0; attempt < 60; attempt++)); do
    kill -0 "$startup_pid" 2>/dev/null || exit 0
    status="$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --max-time 1 http://127.0.0.1:8787/ || true)"
    if [[ "$status" == 200 ]]; then
      printf '\nReady: http://localhost:8787\n'
      if [[ -n "${CODESPACE_NAME:-}" ]]; then
        printf 'Codespaces (Private): https://%s-8787.%s\n' "$CODESPACE_NAME" "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
      fi
      exit 0
    fi
    sleep 1
  done
  echo 'Startup did not return HTTP 200 within 60 checks; inspect the Wrangler output.' >&2
) &

export WRANGLER_LOG_PATH="${WRANGLER_LOG_PATH:-$project_dir/.wrangler/logs}"
exec 9>&-
exec "$project_dir/node_modules/.bin/wrangler" dev --ip 0.0.0.0 --port 8787
