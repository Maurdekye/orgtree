#!/usr/bin/env bash
# Launch smoke on the macOS runner, against the packaged Orgtree.app:
#  1. the bundled engine alone: creates a fresh cluster with the bundled
#     PostgreSQL, reports ready, serves the UI;
#  2. the whole app: Electron starts its engine, which answers on its port,
#     and the app is still up 30 s later.
# Fresh temporary data roots only; no provider sign-ins exist on the runner.
# Usage: smoke.sh <path to Orgtree.app>
set -uo pipefail
app="$1"; res="$app/Contents/Resources"
tmp="$(mktemp -d)"
export ORGTREE_ENGINE_SAFE_START=1
fail() { echo "SMOKE FAILED: $*"; for f in "$tmp"/*.log; do echo "--- $f"; tail -n 80 "$f"; done
  find "$tmp" -path '*diagnostics*' -type f -name '*.log' -exec sh -c 'echo "--- $1"; tail -n 60 "$1"' _ {} \; 2>/dev/null
  find "$tmp" -name postgres.log -exec sh -c 'echo "--- $1"; tail -n 40 "$1"' _ {} \; 2>/dev/null
  exit 1; }
answers() { curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$1/" 2>/dev/null; }
stop_pg() { [ -f "$1/pg/cluster/data/postmaster.pid" ] && "$res/engine/postgresql/bin/pg_ctl" stop -D "$1/pg/cluster/data" -m fast -w >/dev/null 2>&1; true; }

echo "== 1. engine alone"
"$res/engine/orgtree-engine" --version || fail "engine --version"
ORGTREE_DATA="$tmp/engine-root" ORGTREE_V2_UI_DIR="$res/ui" ORGTREE_PG_BOOTSTRAP=1 ORGTREE_V2_TOKEN= \
  "$res/engine/orgtree-engine" serve >"$tmp/engine-stdout.log" 2>"$tmp/engine-stderr.log" &
engine=$!
port=""
for _ in $(seq 1 180); do
  port="$(grep -m1 '"type": *"ready"' "$tmp/engine-stdout.log" 2>/dev/null | python3 -c 'import json,sys;print(json.loads(sys.stdin.read())["port"])' 2>/dev/null)"
  [ -n "$port" ] && break
  kill -0 $engine 2>/dev/null || fail "engine exited before ready"
  sleep 1
done
[ -n "$port" ] || fail "engine not ready in 180 s"
code="$(answers "$port")"
echo "engine ready on port $port, GET / -> $code"
[ "$code" = 200 ] || fail "engine UI did not answer 200"
pgrep -fl "$res/engine/postgresql/bin/postgres" || fail "bundled postgres not running"
kill $engine; sleep 5; kill -9 $engine 2>/dev/null; stop_pg "$tmp/engine-root"
echo "engine smoke OK"

echo "== 2. whole app"
ORGTREE_V2_DATA="$tmp/app-root" "$app/Contents/MacOS/Orgtree" >"$tmp/app.log" 2>&1 &
appid=$!
port=""
for _ in $(seq 1 180); do
  [ -f "$tmp/app-root/engine-port.json" ] && port="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["port"])' "$tmp/app-root/engine-port.json" 2>/dev/null)"
  # the app's engine guards its routes with the desktop token: any HTTP answer counts
  [ -n "$port" ] && [ "$(answers "$port")" != 000 ] && break
  kill -0 $appid 2>/dev/null || fail "app exited"
  sleep 1
done
[ -n "$port" ] && [ "$(answers "$port")" != 000 ] || fail "app's engine never answered"
echo "app's engine answers on port $port (HTTP $(answers "$port"))"
sleep 30
kill -0 $appid 2>/dev/null || fail "app died within 30 s of start"
pgrep -fl "$res/engine/orgtree-engine" || fail "app's engine process gone"
# informational, not gating: the mail hub and the bundled postgres under the app
pgrep -fl "$res/engine/orgtree-mailhub" || echo "note: no orgtree-mailhub process (the engine starts it only when hosting a hub)"
pgrep -fl "$res/engine/postgresql/bin/postgres -D" || echo "note: no app postgres process found"
echo "--- app log (tail)"; tail -n 40 "$tmp/app.log"
echo "the app's mail hub before teardown: $(curl -s -m 3 http://127.0.0.1:7370/healthz || echo 'no answer on 7370')"
kill $appid; for _ in $(seq 1 20); do kill -0 $appid 2>/dev/null || break; sleep 1; done
kill -9 $appid 2>/dev/null
# The background engine outlives the app by design: stop it as launchd would, with SIGTERM
# (bootout also keeps launchd from starting it again).
launchctl bootout "gui/$(id -u)/com.maurdekye.orgtree.engine" 2>/dev/null || true
pkill -TERM -f "$res/engine/orgtree-engine" 2>/dev/null
for _ in $(seq 1 30); do pgrep -f "$res/engine/orgtree-engine" >/dev/null || break; sleep 1; done
pkill -9 -f "$res/engine/orgtree-engine" 2>/dev/null
# SIGTERM stops the engine cleanly, and its mail hub with it
bash "$(dirname "$0")/../unix/hub-gone.sh" 7370 || { pkill -9 -f "$res/engine/orgtree-mailhub"; stop_pg "$tmp/app-root"; fail "the mail hub outlived its engine"; }
stop_pg "$tmp/app-root"
echo "app smoke OK"
