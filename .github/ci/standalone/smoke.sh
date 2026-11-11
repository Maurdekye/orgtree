#!/usr/bin/env bash
# Smoke for the official standalone engine, as a downloader would run it.
#   smoke.sh binary <extracted archive folder> <version> <log dir>
#     PostgreSQL 16+ from ORGTREE_P03_PG_BIN (or the newest /usr/lib/postgresql/*/bin)
#   smoke.sh image <image ref> <version> <log dir>
#     a fresh named volume, the port published on host loopback
# Both: a fresh data root, no token configured (the first start generates one), the
# ready line, 403 without a token and with a wrong one, 200 with it, the engine's
# version is <version>, then SIGTERM: a clean exit (status 0) with PostgreSQL gone.
set -euo pipefail
mode=$1 target=$2 version=$3 logs=$(realpath -m "$4")
mkdir -p "$logs"
fail() { echo "::error::standalone smoke ($mode): $*"; exit 1; }
port='' token='' pid='' cid='' vol=''

wait_ready() { # $1 = command printing the engine's stdout so far, $2 = liveness check
  for _ in $(seq 1 180); do
    line=$($1 2>/dev/null | grep -m1 '"type":"ready"' || true)
    if [ -n "$line" ]; then echo "ready line: $line"; return 0; fi
    $2 || return 1
    sleep 1
  done
  return 1
}

if [ "$mode" = binary ]; then
  eng=$(realpath "$target")/orgtree-engine
  [ -x "$eng" ] || fail "no executable orgtree-engine in $target"
  pgbin=${ORGTREE_P03_PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
  [ -x "$pgbin/initdb" ] || fail "no PostgreSQL binaries (set ORGTREE_P03_PG_BIN)"
  pgmajor=$("$pgbin/postgres" --version | grep -oE '[0-9]+' | head -1)
  echo "PostgreSQL: $("$pgbin/postgres" --version) at $pgbin"
  [ "$pgmajor" -ge 16 ] || fail "PostgreSQL $pgmajor is older than 16"
  file "$eng"; ldd "$eng" || true
  got=$("$eng" --version); [ "$got" = "orgtree-engine $version" ] || fail "--version says '$got', want 'orgtree-engine $version'"
  echo "--version: $got"
  root=$(mktemp -d)/data
  env -u ORGTREE_STANDALONE_TOKEN ORGTREE_DATA="$root" ORGTREE_P03_PG_BIN="$pgbin" \
    "$eng" standalone >"$logs/engine.out" 2>"$logs/engine.err" &
  pid=$!
  trap 'kill -9 $pid 2>/dev/null || true' EXIT
  wait_ready "cat $logs/engine.out" "kill -0 $pid" || { tail -50 "$logs/engine.out" "$logs/engine.err"; fail "engine not ready"; }
  port=$(grep -m1 '"type":"ready"' "$logs/engine.out" | grep -o '"port":[0-9]*' | cut -d: -f2)
  token=$(cat "$root/standalone-token")
  [ "$(stat -c %a "$root/standalone-token")" = 600 ] || fail "standalone-token is not mode 0600"
  grep -q "first-run token" "$logs/engine.err" || fail "the first start did not print its token to stderr"
elif [ "$mode" = image ]; then
  vol="orgtree-smoke-$$-$RANDOM"
  docker volume create "$vol" >/dev/null
  cid=$(docker run -d --env ORGTREE_STANDALONE_TOKEN= -p 127.0.0.1::7430 -v "$vol:/data" "$target")
  trap 'docker rm -f $cid >/dev/null 2>&1 || true; docker volume rm $vol >/dev/null 2>&1 || true' EXIT
  got=$(docker run --rm --entrypoint orgtree-engine "$target" --version)
  [ "$got" = "orgtree-engine $version" ] || fail "--version says '$got', want 'orgtree-engine $version'"
  echo "--version: $got"
  echo "label version: $(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$target")"
  running() { [ "$(docker inspect -f '{{.State.Running}}' "$cid")" = true ]; }
  wait_ready "docker logs $cid" running || { docker logs "$cid" 2>&1 | tail -50; fail "container not ready"; }
  port=$(docker port "$cid" 7430/tcp | head -1 | sed 's/.*://')
  token=$(docker exec "$cid" cat /data/standalone-token)
  # captured first: `docker logs | grep -q` under pipefail fails when grep exits early (SIGPIPE)
  started=$(docker logs "$cid" 2>&1)
  grep -q "first-run token" <<<"$started" || fail "the first start did not print its token to the container log"
else
  fail "mode must be binary or image"
fi

url="http://127.0.0.1:$port"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code "$url/api/desktop/alive")" = 403 ] || fail "no token: want 403"
[ "$(code -H "Authorization: Bearer wrong-token-wrong-token-wrong-token" "$url/api/desktop/alive")" = 403 ] || fail "wrong token: want 403"
echo "no token -> 403, wrong token -> 403"
[ "$(code -H "Authorization: Bearer $token" "$url/api/desktop/alive")" = 200 ] || fail "with the token: want 200"
echo "token -> 200"
engine=$(curl -fsS -H "Authorization: Bearer $token" "$url/api/host" | grep -o '"engine":"[^"]*"')
[ "$engine" = "\"engine\":\"orgtree-engine $version\"" ] || fail "/api/host says $engine, want orgtree-engine $version"
echo "/api/host: $engine"

if [ "$mode" = binary ]; then
  kill -TERM "$pid"
  status=0; for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -0 "$pid" 2>/dev/null && fail "engine still running 60 s after SIGTERM"
  wait "$pid" || status=$?
  trap - EXIT
  [ "$status" = 0 ] || { tail -30 "$logs/engine.err"; fail "exit status $status after SIGTERM, want 0"; }
  sleep 2
  pgrep -f -- "-D $root/pg" >/dev/null && fail "PostgreSQL still running after a clean exit"
  cp -r "$root/logs" "$logs/engine-logs" 2>/dev/null || true
  rm -rf "$(dirname "$root")"
else
  docker stop -t 60 "$cid" >/dev/null   # SIGTERM, then SIGKILL after 60 s
  status=$(docker inspect -f '{{.State.ExitCode}}' "$cid")
  docker logs "$cid" >"$logs/container.out" 2>"$logs/container.err"
  [ "$status" = 0 ] || { tail -30 "$logs/container.err"; fail "container exit status $status after SIGTERM, want 0"; }
fi
echo "SIGTERM -> clean exit (0)"
echo "standalone smoke ($mode) passed for $version"
