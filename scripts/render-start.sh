#!/bin/sh
# Start command of Dockerfile.render (D82): single-service test hosting (e.g. Render).
#
# 1. Starts redis-server inside the container, on 127.0.0.1:6379 only, with no persistence
#    (queued jobs are lost on a container restart: accepted for testing, D82).
# 2. Waits until it answers PING.
# 3. Replaces this shell with the API in single-process mode (HTTP API + job workers,
#    RUN_WORKERS=true by default) on the host's $PORT. REDIS_URL defaults to the local Redis.
#
# If Redis exits, the API is sent SIGTERM (graceful close), so the container exits and the host
# restarts it. If the API exits, the container exits. Prints no configuration values.
set -eu

REDIS_PORT=6379
REDIS_MAXMEMORY="${REDIS_MAXMEMORY:-64mb}"

# The API keeps this PID after `exec` below, so the watcher can signal it.
api_pid=$$

(
  redis-server \
    --bind 127.0.0.1 \
    --port "$REDIS_PORT" \
    --protected-mode yes \
    --dir /tmp \
    --save "" \
    --appendonly no \
    --maxmemory "$REDIS_MAXMEMORY" \
    --maxmemory-policy noeviction \
    --loglevel warning \
    || true
  echo "render-start: redis-server exited; stopping the API so the container restarts" >&2
  kill -TERM "$api_pid" 2>/dev/null || true
) &

tries=0
until redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping 2>/dev/null | grep -q PONG; do
  tries=$((tries + 1))
  if [ "$tries" -ge 100 ]; then
    echo "render-start: redis did not answer PING within 20 s" >&2
    exit 1
  fi
  sleep 0.2
done
echo "render-start: redis ready on 127.0.0.1:$REDIS_PORT" >&2

export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:$REDIS_PORT}"
export RUN_WORKERS="${RUN_WORKERS:-true}"

exec node dist/main.js
