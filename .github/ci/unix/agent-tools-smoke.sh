#!/usr/bin/env bash
# Agent tool calls through the PACKAGED engine on Linux and macOS, one per CLI lane:
#  - claude: the CLI talks stream-json over stdio and reaches the Orgtree tools through
#    the engine's in-process MCP server (sdkMcpServers), as Claude Code does;
#  - agy:    the CLI starts `orgtree-engine mcp-bridge` from the agent's workspace
#    plugin, which relays to the engine over the agent's private bridge socket, as
#    Antigravity does.
# The rig's fake CLI (tools/rig/fakecli) stands in for both CLIs: the engine finds it
# exactly as it finds the real ones (ORGTREE_CLAUDE_BIN, and `agy` on PATH), and its
# scenario makes one real orgtree_status call per agent. The lane counts as signed in
# the way the engine reads it (an account email in a throwaway ~/.claude.json); no
# credential exists on the runner and nothing here reaches a provider.
# A lane passes only if the fake CLI logs the tool's answer as expected AND the engine
# then reports the status that call set. Written for bash 3.2 (macOS) as well.
# Usage: agent-tools-smoke.sh <orgtree-engine> <ui dir> <orgtree-fakecli> <logs dir>
# AGENT_SMOKE_LANES (default "claude agy") picks the lanes.
set -uo pipefail
eng="$1" ui="$2" fake="$3" logs="$4"
lanes="${AGENT_SMOKE_LANES:-claude agy}"
mkdir -p "$logs"
work="$(mktemp -d)"
home="$work/home" bin="$work/bin" fdir="$work/fakecli" root="$work/data"
mkdir -p "$home" "$bin" "$fdir"
cp "$fake" "$bin/claude" && cp "$fake" "$bin/agy" && chmod +x "$bin/claude" "$bin/agy" || { echo "::error::cannot stage the fake CLI"; exit 1; }
printf '{"oauthAccount":{"emailAddress":"smoke@example.com"}}\n' > "$home/.claude.json"
cat > "$fdir/scenario.json" <<'EOF'
{"default": {"turns": [{"name": "tool-smoke", "steps": [
  {"tool": "orgtree_status", "args": {"status": "done", "summary": "agent tool smoke"}, "expect": "Status recorded"},
  {"text": "OK."}]}]}}
EOF
token="$(openssl rand -hex 32)"
pid="" port=""

tier_of() { case "$1" in claude) echo haiku ;; agy) echo flash ;; *) echo "unknown lane $1" >&2; return 1 ;; esac; }
collect() {
  cp -r "$fdir/log" "$logs/fakecli-log" 2>/dev/null
  cp -r "$root/logs" "$logs/engine-logs" 2>/dev/null
  find "$root" -path '*/.agents/plugins/orgtree/mcp_config.json' -exec cp {} "$logs/agy-mcp_config.json" \; 2>/dev/null
  true
}
stop_engine() {
  [ -n "$pid" ] || return 0
  [ -n "$port" ] && curl -sS -m 10 -X POST -H "X-Orgtree-Desktop-Token: $token" "http://127.0.0.1:$port/api/desktop/shutdown" -o /dev/null 2>/dev/null
  for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -9 "$pid" 2>/dev/null
  local pgctl; pgctl="$(dirname "$eng")/postgresql/bin/pg_ctl"
  [ -x "$pgctl" ] && [ -f "$root/pg/cluster/data/postmaster.pid" ] && "$pgctl" stop -D "$root/pg/cluster/data" -m fast -w >/dev/null 2>&1
  pkill -9 -f -- "-D $root/pg/cluster/data" 2>/dev/null
  pid=""
}
trap stop_engine EXIT
fail() {
  echo "::error::agent tool smoke: $*"
  for f in "$fdir"/log/*.jsonl; do [ -f "$f" ] && { echo "--- $f"; tail -n 40 "$f"; }; done
  echo "--- engine stderr (tail)"; tail -n 60 "$logs/engine.err" 2>/dev/null
  collect; exit 1
}
api() { # METHOD ROUTE [JSON]: prints the body; fails on a non-2xx answer
  local out code url="http://127.0.0.1:$port$2"
  if [ $# -ge 3 ]; then
    out="$(curl -sS -m 30 -X "$1" -H "X-Orgtree-Desktop-Token: $token" -H 'Content-Type: application/json' --data "$3" -w $'\n%{http_code}' "$url")" || return 1
  else
    out="$(curl -sS -m 30 -X "$1" -H "X-Orgtree-Desktop-Token: $token" -w $'\n%{http_code}' "$url")" || return 1
  fi
  code="${out##*$'\n'}"; printf '%s\n' "${out%$'\n'*}"
  [ "${code:0:1}" = 2 ] || { echo "HTTP $code from $1 $2" >&2; return 1; }
}

echo "== engine (packaged: $eng)"
env HOME="$home" PATH="$bin:$PATH" ORGTREE_CLAUDE_BIN="$bin/claude" \
  ORGTREE_FAKECLI_DIR="$fdir" ORGTREE_FAKECLI_HOME="$home" \
  ORGTREE_DATA="$root" ORGTREE_V2_TOKEN="$token" ORGTREE_V2_UI_DIR="$ui" \
  ORGTREE_PG_BOOTSTRAP=1 ORGTREE_ENGINE_SAFE_START=1 \
  "$eng" serve >"$logs/engine.out" 2>"$logs/engine.err" &
pid=$!
for _ in $(seq 1 180); do
  port="$(python3 -c 'import json,sys
for l in open(sys.argv[1], errors="replace"):
    try: m = json.loads(l)
    except Exception: continue
    if isinstance(m, dict) and m.get("type") == "ready": print(m["port"]); break' "$logs/engine.out" 2>/dev/null)"
  [ -n "$port" ] && break
  kill -0 "$pid" 2>/dev/null || fail "engine exited before ready"
  sleep 1
done
[ -n "$port" ] || fail "engine not ready within 180 s"
echo "engine ready on port $port"
echo "--- lanes as the engine sees them (informational)"
api GET /api/providers | python3 -c 'import json,sys
d = json.load(sys.stdin)
for k, v in (d.items() if isinstance(d, dict) else enumerate(d)):
    if isinstance(v, dict): print(k, {x: v.get(x) for x in ("installed", "connected", "hire", "path", "version") if x in v})' \
  || echo "(no provider summary)"

org="$(api POST /api/orgs '{"name":"Tool Smoke","dirs":[],"net_autoconnect":false}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["slug"])')" \
  || fail "could not create an org"
[ -n "$org" ] || fail "org create returned no slug"
echo "org $org"
for lane in $lanes; do
  name="tools-$lane"; tier="$(tier_of "$lane")" || fail "unknown lane $lane"
  api POST "/api/orgs/$org/ops" "{\"op\":\"hire\",\"name\":\"$name\",\"tier\":\"$tier\",\"grant\":0,\"title\":\"Tool smoke\",\"charter\":\"You exist only in a CI smoke test.\"}" >/dev/null \
    || fail "$lane: hiring $name (tier $tier) was refused"
  api POST "/api/orgs/$org/nodes/$name/message" '{"text":"Run the tool smoke.","notice":false}' >/dev/null \
    || fail "$lane: user mail to $name was refused"
  echo "$lane: hired $name (tier $tier) and sent it a message"
done

# The fake CLI's verdict per lane, written to $work/result-<lane> once its tool answer is in.
for _ in $(seq 1 240); do
  pending=0
  for lane in $lanes; do
    [ -s "$work/result-$lane" ] && continue
    python3 -c 'import json,sys
v = ""
try:
    for l in open(sys.argv[1], errors="replace"):
        try: m = json.loads(l)
        except Exception: continue
        if m.get("kind") == "tool_result" and m.get("tool") == "orgtree_status":
            v = "pass" if m.get("ok") is True and not m.get("is_error") else "fail: " + str(m.get("text"))[:300]
except FileNotFoundError: pass
if v: open(sys.argv[2], "w").write(v)' "$fdir/log/tools-$lane.jsonl" "$work/result-$lane" 2>/dev/null
    if [ -s "$work/result-$lane" ]; then echo "$lane: the fake CLI got the tool's answer: $(cat "$work/result-$lane")"; else pending=1; fi
  done
  [ "$pending" = 0 ] && break
  kill -0 "$pid" 2>/dev/null || fail "engine exited during the turns"
  sleep 1
done

bad=0
for lane in $lanes; do
  name="tools-$lane"; verdict="$(cat "$work/result-$lane" 2>/dev/null)"
  case "$verdict" in
    pass)
      if api GET "/api/orgs/$org/nodes/$name/detail" | grep -q 'agent tool smoke'; then
        echo "PASS $lane: orgtree_status ran through the engine, and the engine reports the status it set"
      else
        echo "FAIL $lane: the tool answered, but the engine does not report the status it set"; bad=1
      fi ;;
    "") echo "FAIL $lane: no tool call within 240 s (the CLI never ran the turn, or never reached the tool)"; bad=1 ;;
    *) echo "FAIL $lane: $verdict"; bad=1 ;;
  esac
done
[ "$bad" = 0 ] || fail "one or more lanes failed (see above)"
collect
echo "agent tool smoke passed ($lanes)"
