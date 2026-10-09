#!/usr/bin/env bash
# The packaged engine on its own: bootstrap a fresh cluster, answer /api/desktop/alive,
# shut down cleanly, then survive a crash (kill -9) and start again on the same root.
set -euo pipefail
res=$(realpath "$1")/resources
eng=$res/engine/orgtree-engine
logs=$(realpath -m build/linux/smoke-logs); mkdir -p "$logs"
root=$(mktemp -d)/data
token=$(openssl rand -hex 32)
pid=

start() { # $1 = label, $2 = bootstrap 0/1
  local out=$logs/engine-$1.out
  env ORGTREE_DATA="$root" ORGTREE_V2_TOKEN="$token" ORGTREE_V2_UI_DIR="$res/ui" \
      ORGTREE_PG_BOOTSTRAP="$2" ORGTREE_ENGINE_SAFE_START=1 \
      "$eng" serve >"$out" 2>"$logs/engine-$1.err" &
  pid=$!
  for _ in $(seq 1 180); do
    if grep -q '"type":"ready"' "$out"; then
      port=$(grep '"type":"ready"' "$out" | head -1 | grep -o '"port":[0-9]*' | cut -d: -f2)
      echo "$1: engine pid $pid ready on port $port"; return 0
    fi
    kill -0 "$pid" 2>/dev/null || { echo "::error::$1: engine exited before ready"; tail -50 "$out" "$logs/engine-$1.err"; return 1; }
    sleep 1
  done
  echo "::error::$1: engine not ready within 180 s"; tail -50 "$out"; return 1
}
alive() {
  curl -fsS -H "X-Orgtree-Desktop-Token: $token" "http://127.0.0.1:$port/api/desktop/alive"; echo
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/")
  echo "GET / -> $code"
}
postgres_running() { pgrep -f -- "-D $root/pg/cluster/data" >/dev/null; }

start first 1
alive
curl -fsS -X POST -H "X-Orgtree-Desktop-Token: $token" "http://127.0.0.1:$port/api/desktop/shutdown" -o /dev/null || true
for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
kill -0 "$pid" 2>/dev/null && { echo "::error::engine did not exit after shutdown"; exit 1; }
sleep 2; postgres_running && { echo "::error::postgres still running after a clean shutdown"; exit 1; }
echo "clean shutdown OK"

start second 0
alive
# PDEATHSIG is tied to the spawning thread: postgres must outlive any short-lived
# thread (still up after 60 s) yet die within seconds of the engine itself.
sleep 60
postgres_running || { echo "::error::postgres died while the engine was running"; tail -30 "$root/pg/cluster/log/postgres.log"; exit 1; }
alive
echo "postgres still up 60 s after engine start OK"
kill -9 "$pid"; sleep 5
if postgres_running; then echo "::error::postgres outlived a killed engine"; pgrep -af postgres; exit 1; fi
echo "postgres died with the engine OK"

start third 0
alive
kill "$pid"; for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
cp -r "$root/pg/cluster/log" "$logs/pg-log" 2>/dev/null || true
cp -r "$root/logs" "$logs/engine-logs" 2>/dev/null || true
echo "engine smoke passed"
