#!/bin/bash
set -e

APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
APP_NAME="${APP_NAME:-aetheris}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"

cd "$APP_DIR"

echo "-> Pulling latest..."
git pull --ff-only

echo "-> Installing dependencies..."
pnpm install --frozen-lockfile

echo "-> Validating + installing Caddyfile..."
# validate the repo copy, ship it, then reload — this keeps /etc/caddy/Caddyfile
# from drifting away from the reviewed file in the repo
caddy validate --adapter caddyfile --config "$APP_DIR/Caddyfile" > /dev/null
install -m 0644 "$APP_DIR/Caddyfile" /etc/caddy/Caddyfile

echo "-> Reloading Caddy..."
caddy reload --config /etc/caddy/Caddyfile

echo "-> Restarting app..."
# Kill only orphaned Aetheris instances before PM2 restarts its managed one.
# The previous loop also killed PM2's current PID, allowing PM2 to race us by
# spawning a replacement while the deploy was still cleaning up port 8080.
# pgrep matches the script name alone: PM2 starts node with --env-file in
# between (node --env-file=... index.js), so 'node index\.js' never matched
# the very processes this loop must skip.
managed_pids="$(pm2 pid "$APP_NAME" 2>/dev/null | tr -d '\r' || true)"
orphan_pids=()
for pid in $(pgrep -f 'index\.js' 2>/dev/null || true); do
    [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$APP_DIR" ] || continue
    managed=false
    for managed_pid in $managed_pids; do
        if [ "$pid" = "$managed_pid" ]; then
            managed=true
        fi
    done
    if [ "$managed" = false ]; then
        echo "-> Stopping orphaned Aetheris PID $pid..."
        kill "$pid" 2>/dev/null || true
        orphan_pids+=("$pid")
    fi
done

# Do not restart until every orphan has actually released its listener.
for pid in "${orphan_pids[@]}"; do
    for _ in {1..50}; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
        echo "-> Orphan PID $pid ignored SIGTERM; sending SIGKILL..."
        kill -KILL "$pid" 2>/dev/null || true
        for _ in {1..20}; do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.1
        done
    fi
done

if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
    pm2 restart "$APP_NAME"
else
    pm2 start index.js \
        --name "$APP_NAME" \
        --cwd "$APP_DIR" \
        --node-args="--env-file=$ENV_FILE" \
        --kill-timeout 5000
    pm2 save
fi

# A restart that never binds is still a failed deploy. Verify the app answers
# on its loopback port before reporting success.
if command -v curl > /dev/null 2>&1; then
    healthy=false
    for _ in {1..40}; do
        if curl -fsS --max-time 3 "http://127.0.0.1:${PORT:-8080}/online-count" > /dev/null 2>&1; then
            healthy=true
            break
        fi
        sleep 0.5
    done
    if [ "$healthy" = true ]; then
        echo "-> Health check OK"
    else
        echo "!! Health check FAILED: app is not answering on 127.0.0.1:${PORT:-8080}" >&2
        echo "!! Check: pm2 logs $APP_NAME --err" >&2
        exit 1
    fi
else
    echo "-> curl not found; skipping post-restart health check"
fi

echo "Done"
