#!/usr/bin/env bash
# Agent tool calls through the PACKAGED engine on Linux and macOS, one per CLI lane:
#  - claude: the CLI talks stream-json over stdio and reaches the Orgtree tools through
#    the engine's in-process MCP server (sdkMcpServers), as Claude Code does;
#  - codex:  `codex app-server` over stdio, the tools as dynamic tools, as Codex does;
#  - agy:    the CLI starts `orgtree-engine mcp-bridge` from the agent's workspace
#    plugin, which relays to the engine over the agent's private bridge socket, as
#    Antigravity does.
# The rig's fake CLI (tools/rig/fakecli) stands in for all three CLIs: the engine finds
# it exactly as it finds the real ones (ORGTREE_CLAUDE_BIN, ORGTREE_CODEX_BIN, and `agy`
# on PATH), and its scenario makes one real orgtree_status call per agent. Each lane
# counts as signed in the way the engine reads it (an account email in a throwaway
# ~/.claude.json; a ~/.codex/auth.json whose made-up id token carries only an email);
# no credential exists on the runner and nothing here reaches a provider.
# A lane passes only if the fake CLI logs the tool's answer as expected AND the engine
# then reports the status that call set.
# Also, in the same engine run:
#  - the hosted mail hub (mailhub-hosting.json, loopback) must answer /healthz. A
#    failure is a warning, not a failed job (phone setup is out of scope here);
#  - with AGENT_SMOKE_LEFTOVERS=1 (set when the fake CLI has its `spawn` step): a CLI
#    child started mid-turn must not outlive its agent's process being stopped, nor
#    a graceful engine shutdown;
#  - with the agy lane: an Antigravity agent without shell rights (tools.bash off) has
#    its run_command denied by the engine's PreToolUse hook, which the CLI runs through
#    a shell.
# The data folder's name has a space in it, as the real one ("Orgtree v2") does.
# Written for bash 3.2 (macOS) as well.
# Usage: agent-tools-smoke.sh <orgtree-engine> <ui dir> <orgtree-fakecli> <logs dir>
# AGENT_SMOKE_LANES (default "claude codex agy") picks the lanes.
set -uo pipefail
eng="$1" ui="$2" fake="$3" logs="$4"
lanes="${AGENT_SMOKE_LANES:-claude codex agy}"
leftovers="${AGENT_SMOKE_LEFTOVERS:-0}"
mkdir -p "$logs"
work="$(mktemp -d)"
home="$work/home" bin="$work/bin" fdir="$work/fakecli" root="$work/Orgtree v2"
mkdir -p "$home/.codex" "$bin" "$fdir" "$root"
for cli in claude codex agy; do cp "$fake" "$bin/$cli" && chmod +x "$bin/$cli" || { echo "::error::cannot stage the fake CLI"; exit 1; }; done
printf '{"oauthAccount":{"emailAddress":"smoke@example.com"}}\n' > "$home/.claude.json"
python3 -c 'import base64,json,sys
b = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
json.dump({"OPENAI_API_KEY": None, "tokens": {"id_token": b({"alg": "none"}) + "." + b({"email": "smoke@example.com"}) + "."}},
          open(sys.argv[1], "w"))' "$home/.codex/auth.json"
python3 -c 'import json,sys
hang = {"turns": [{"name": "spawn-and-hang", "steps": [{"spawn": "sleep 300"}, {"hang": True}]}]}
noshell = {"turns": [{"name": "shell", "steps": [
    {"tool": "run_command", "args": {"CommandLine": "echo hi", "Cwd": "."}, "result": "hi"},
    {"text": "I may not use the shell."}]}]}
json.dump({"agents": {"left-stop": hang, "left-shutdown": hang, "tools-agy-noshell": noshell},
           "default": {"turns": [{"name": "tool-smoke", "steps": [
               {"tool": "orgtree_status", "args": {"status": "done", "summary": "agent tool smoke"}, "expect": "Status recorded"},
               {"text": "OK."}]}]}}, open(sys.argv[1], "w"), indent=1)' "$fdir/scenario.json"
hubport="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
printf '{"version": 2, "port": %s, "bind": "127.0.0.1", "name": "smoke hub", "retention_days": null, "public_listener": false, "max_attachment_bytes": 1073741824}\n' \
  "$hubport" > "$root/mailhub-hosting.json"
token="$(openssl rand -hex 32)"
pid="" port="" spawned=""

tier_of() { case "$1" in claude) echo haiku ;; codex) echo luna ;; agy) echo flash ;; *) echo "unknown lane $1" >&2; return 1 ;; esac; }
collect() {
  cp -r "$fdir/log" "$logs/fakecli-log" 2>/dev/null
  cp -r "$root/logs" "$logs/engine-logs" 2>/dev/null
  cp "$root/mailhub/hub.log" "$logs/hub.log" 2>/dev/null
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
cleanup() { stop_engine; for p in $spawned; do kill -9 "$p" 2>/dev/null; done; true; }
trap cleanup EXIT
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
hire_and_wake() { # name tier [more hire fields, as ',"key":value']
  api POST "/api/orgs/$org/ops" "{\"op\":\"hire\",\"name\":\"$1\",\"tier\":\"$2\",\"grant\":0,\"title\":\"Tool smoke\",\"charter\":\"You exist only in a CI smoke test.\"${3:-}}" >/dev/null \
    || fail "hiring $1 (tier $2) was refused"
  api POST "/api/orgs/$org/nodes/$1/message" '{"text":"Run the tool smoke.","notice":false}' >/dev/null \
    || fail "user mail to $1 was refused"
  echo "hired $1 (tier $2) and sent it a message"
}
spawned_pid() { # agent: the pid of the child its fake CLI spawned, once logged
  python3 -c 'import json,sys
try:
    for l in open(sys.argv[1], errors="replace"):
        try: m = json.loads(l)
        except Exception: continue
        if m.get("kind") == "spawned" and m.get("child_pid"): print(m["child_pid"]); break
except FileNotFoundError: pass' "$fdir/log/$1.jsonl" 2>/dev/null
}
gone_within() { # pid seconds
  for _ in $(seq 1 "$2"); do kill -0 "$1" 2>/dev/null || return 0; sleep 1; done
  ! kill -0 "$1" 2>/dev/null
}

echo "== engine (packaged: $eng)"
env HOME="$home" PATH="$bin:$PATH" ORGTREE_CLAUDE_BIN="$bin/claude" ORGTREE_CODEX_BIN="$bin/codex" \
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
  tier="$(tier_of "$lane")" || fail "unknown lane $lane"
  hire_and_wake "tools-$lane" "$tier"
done
noshell=0
case " $lanes " in *" agy "*) noshell=1; hire_and_wake tools-agy-noshell "$(tier_of agy)" ',"tools":{"bash":false}' ;; esac

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

if [ "$noshell" = 1 ]; then
  echo "--- an Antigravity agent without shell rights"
  verdict=""
  for _ in $(seq 1 120); do
    verdict="$(python3 -c 'import json,re,sys
hook = res = None
try:
    for l in open(sys.argv[1], errors="replace"):
        try: m = json.loads(l)
        except Exception: continue
        if m.get("kind") == "hook" and m.get("event") == "PreToolUse" and m.get("tool") == "run_command": hook = m
        if m.get("kind") == "tool_result" and m.get("tool") == "run_command": res = m
except FileNotFoundError: pass
if res is not None:
    ok = (hook is not None and hook.get("decision") == "deny" and re.search("shell rights", str(hook.get("reason") or ""))
          and res.get("denied") is True and re.search("denied by pre-tool hook", str(res.get("text") or "")))
    print("pass" if ok else "fail: hook %s; result %s" % (json.dumps(hook)[:300], json.dumps(res)[:300]))' "$fdir/log/tools-agy-noshell.jsonl" 2>/dev/null)"
    [ -n "$verdict" ] && break
    sleep 1
  done
  case "$verdict" in
    pass) echo "PASS agy without shell rights: the PreToolUse hook ran through a shell and denied run_command" ;;
    "") echo "FAIL agy without shell rights: no run_command call within 120 s"; bad=1 ;;
    *) echo "FAIL agy without shell rights: $verdict"; bad=1 ;;
  esac
fi

echo "--- hosted mail hub (port $hubport)"
hub=""
for _ in $(seq 1 60); do
  hub="$(curl -sS -m 3 "http://127.0.0.1:$hubport/healthz" 2>/dev/null)" && [ -n "$hub" ] && break
  hub=""; sleep 1
done
if [ -n "$hub" ]; then
  echo "PASS hub: the hosted mail hub answers /healthz: $(printf '%s' "$hub" | head -c 300)"
else
  echo "::warning::the hosted mail hub did not answer /healthz on port $hubport (a known limit if it stays so; not gating)"
  tail -n 40 "$root/mailhub/hub.log" 2>/dev/null
  pgrep -fl orgtree-mailhub || echo "(no orgtree-mailhub process)"
fi

if [ "$leftovers" = 1 ]; then
  echo "--- leftovers: a CLI's child must not outlive its agent's process, nor the engine"
  hire_and_wake left-stop "$(tier_of claude)"
  hire_and_wake left-shutdown "$(tier_of claude)"
  stop_pid="" down_pid=""
  for _ in $(seq 1 120); do
    [ -n "$stop_pid" ] || stop_pid="$(spawned_pid left-stop)"
    [ -n "$down_pid" ] || down_pid="$(spawned_pid left-shutdown)"
    [ -n "$stop_pid" ] && [ -n "$down_pid" ] && break
    sleep 1
  done
  spawned="$stop_pid $down_pid"
  if [ -z "$stop_pid" ] || [ -z "$down_pid" ]; then
    echo "FAIL leftovers: the fake CLIs never reported their spawned child (left-stop: ${stop_pid:-none}, left-shutdown: ${down_pid:-none})"; bad=1
  else
    kill -0 "$stop_pid" 2>/dev/null && kill -0 "$down_pid" 2>/dev/null || echo "note: a spawned child was already gone before any stop"
    api POST "/api/orgs/$org/nodes/left-stop/process" '{"action":"stop"}' >/dev/null || echo "note: the process stop route answered with an error"
    if gone_within "$stop_pid" 20; then echo "PASS leftovers (stop): the child of a stopped agent's CLI is gone"
    else echo "FAIL leftovers (stop): pid $stop_pid ($(ps -o command= -p "$stop_pid" 2>/dev/null)) outlived its agent's stopped process"; bad=1; fi
  fi
fi

collect
stop_engine
if [ "$leftovers" = 1 ] && [ -n "${down_pid:-}" ]; then
  if gone_within "$down_pid" 20; then echo "PASS leftovers (shutdown): the child of a mid-turn CLI is gone after a graceful engine shutdown"
  else echo "FAIL leftovers (shutdown): pid $down_pid ($(ps -o command= -p "$down_pid" 2>/dev/null)) outlived the engine"; bad=1; fi
fi
[ "$bad" = 0 ] || fail "one or more checks failed (see above)"
echo "agent tool smoke passed (lanes: $lanes; no-shell agent: $([ "$noshell" = 1 ] && echo checked || echo skipped); leftovers:$([ "$leftovers" = 1 ] && echo checked || echo skipped))"
