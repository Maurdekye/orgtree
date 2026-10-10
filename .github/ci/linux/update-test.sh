#!/usr/bin/env bash
# The AppImage updates itself on the runner, the way it will on a user's PC.
#
# Version N (this commit) and N+1 (the same build, one patch version up) are packaged by
# electron-builder.update-test.cjs with a loopback feed in place of GitHub's. N is
# installed as ~/Applications/Orgtree-<N>.AppImage and started with FUSE under a
# standalone Xvfb (the display must outlive the old app, so not xvfb-run), with
# systemd --user, so it registers its background engine, and with umask 0002 as on Ubuntu. N+1 waits on the loopback feed
# (update-feed.mjs). Nothing else is done to the app: its own automatic path checks the
# feed, downloads N+1 (differentially, from the blockmap embedded in N), waits for 60 s
# without input, stops the background engine, swaps the file in place and relaunches.
# Passes when the file, the one running desktop and the background engine are all N+1,
# the engine answers, update-log.json records the swap and the relaunch, and Orgtree's
# folders stay private (0700) under the unit's UMask=0077, before and after.
#   bash .github/ci/linux/update-test.sh <logs dir>   (repository root, after the release build)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
logs=$(realpath -m "$1"); mkdir -p "$logs"
work=$(realpath -m build/linux/update-test); rm -rf "$work"; mkdir -p "$work/feed"
port=47615; feed="http://127.0.0.1:$port/"
core=$(node -p 'require("./package.json").version.split("-")[0]')
IFS=. read -r major minor patch <<<"$core"
vN="$major.$minor.$patch"; vN1="$major.$minor.$((patch + 1))"
apps="$HOME/Applications"; app="$apps/Orgtree-$vN.AppImage"
profile="$HOME/.config/Orgtree v2"   # the release identity's userData
unit=orgtree-engine.service
autostart="$HOME/.config/autostart/orgtree-engine.desktop"   # the app's fallback without systemd --user
shim_dir="$HOME/.local/bin"   # on the runner's PATH (and a desktop's), ahead of /usr/bin
systemctl_log="$logs/systemctl-calls.log"
budget=${UPDATE_TEST_BUDGET:-420}
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
step() { echo "--- $*"; }

# "<pid> <ppid> <role> <version>" for everything running from $app (appimage-procs.mjs)
procs() { node "$here/appimage-procs.mjs" "$app"; }
pids_of() { procs | awk -v role="$1" '$3 == role { print $1 }'; }
version_of() { procs | awk -v pid="$1" '$1 == pid { print $4 }'; }
main_pid() { /usr/bin/systemctl --user show -p MainPID --value "$unit" 2>/dev/null || echo 0; }
engine_port() { local f; f=$(find "$profile" -name engine-port.json 2>/dev/null | head -1); [ -n "$f" ] && grep -o '[0-9]*' "$f" | head -1; }
mode_of() { stat -c '%a' "$1" 2>/dev/null || echo missing; }
# Failures that do not stop the run: reported together at the end, after everything else.
late=()
# From 4.1.2 Orgtree keeps its folders private (0700) and its unit carries UMask=0077,
# whatever the session's umask (Ubuntu's is 0002).
check_private() {  # <when>
  local d u=
  for d in "$profile" "$profile/data"; do [ "$(mode_of "$d")" = 700 ] || late+=("$1: $d is $(mode_of "$d"), not 700"); done
  if [ "$manager" = systemd ]; then
    u=$(/usr/bin/systemctl --user show "$unit" -p UMask --value 2>/dev/null)
    [ "$u" = 0077 ] || late+=("$1: $unit has UMask $u, not 0077")
  fi
  echo "$1: folders $(mode_of "$profile") and $(mode_of "$profile/data")${u:+; $unit UMask $u}"
}
update_log() {
  node -e 'for (const e of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")))
    console.log([e.at, e.stage, e.from && e.to ? `${e.from} -> ${e.to}` : "", typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail ?? "")].filter(Boolean).join("  "))' \
    "$profile/update-log.json" 2>/dev/null || echo "(no update-log.json yet)"
}
diagnostics() {
  set +e
  echo "--- update-log.json"; update_log
  echo "--- running from $app (pid ppid role version)"; procs
  echo "--- processes"; ps -eo pid,ppid,etimes,args | grep -E 'Orgtree|orgtree|mount_Orgtre|Xvfb' | grep -v grep | cut -c1-220
  echo "--- $unit"; /usr/bin/systemctl --user status "$unit" --no-pager 2>&1 | head -20
  echo "--- systemctl calls (the logging shim in $shim_dir)"; cat "$systemctl_log" 2>/dev/null
  echo "--- $apps"; ls -la "$apps"
  echo "--- the first app's output (the relaunched one's goes nowhere)"; grep -v appimage_extracted "$logs/app.out" | tail -40
  find "$profile" -path '*diagnostics/logs/*' -type f 2>/dev/null | while read -r f; do echo "--- $f"; tail -30 "$f"; done
}
fail() { echo "::error::$*"; diagnostics; exit 1; }

teardown() {
  set +e
  step "teardown"
  cp "$profile/update-log.json" "$logs/" 2>/dev/null
  cp "$HOME/.config/systemd/user/$unit" "$logs/" 2>/dev/null
  cp -r "$profile/diagnostics" "$logs/app-diagnostics" 2>/dev/null
  cp "$autostart" "$logs/" 2>/dev/null
  for p in $(pids_of desktop); do kill -TERM "$p"; done
  /usr/bin/systemctl --user disable --now "$unit" >/dev/null 2>&1
  rm -f "$HOME/.config/systemd/user/$unit" "$autostart"; /usr/bin/systemctl --user daemon-reload
  # a host the app started outside systemd (the autostart fallback) passes SIGTERM to its engine
  for p in $(pids_of host); do kill -TERM "$p"; done
  for _ in $(seq 1 30); do [ -z "$(procs)" ] && break; sleep 1; done
  left=$(procs); if [ -n "$left" ]; then echo "::warning::killing what did not stop:"; echo "$left"; echo "$left" | awk '{ print $1 }' | xargs -r kill -KILL; fi
  [ -n "${feedpid:-}" ] && kill "$feedpid"
  [ -n "${xvfbpid:-}" ] && kill "$xvfbpid"
  rm -f "$shim_dir/systemctl"
  bash "$here/../unix/hub-gone.sh" 7370 || { pkill -KILL -f orgtree-mailhub; exit 1; }
}

step "pre-flight"
/usr/bin/systemctl --user show-environment >/dev/null 2>&1 || fail "systemd --user is not available (the background engine steps enable lingering first)"
[ -e "$HOME/.config/systemd/user/$unit" ] && fail "$unit is already registered: an earlier step left it"
pgrep -af "orgtree-engine|mount_Orgtre" && fail "Orgtree is already running"
if [ -e "$profile" ]; then echo "moving an earlier step's profile aside"; mv "$profile" "$work/earlier-profile"; fi
userns=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo n/a)
echo "N = $vN, N+1 = $vN1; feed $feed; kernel.apparmor_restrict_unprivileged_userns=$userns"
env | grep -E '^(XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP)=' | sed 's/^/  /' || true
svc_umask=$(timeout 30 systemd-run --user --wait --pipe --quiet sh -c umask 2>&1 || true)
echo "user $(id -un) ($(id -u)), primary group $(id -gn) ($(id -g)); this shell's umask $(umask); a user service's umask: $svc_umask; ~/.config $(mode_of "$HOME/.config")"

step "packaging N and N+1 from this commit and this engine build (AppImage only, loopback feed)"
package() {  # <version> <label>
  local out="$work/$2"; mkdir -p "$out"
  node -e 'const fs = require("fs"); const info = JSON.parse(fs.readFileSync("dist/build-info.json", "utf8"));
    info.version = process.argv[1]; fs.writeFileSync(process.argv[2], JSON.stringify(info, null, 2) + "\n")' "$1" "$out/build-info.json"
  if ! UPDATE_TEST_VERSION=$1 UPDATE_TEST_FEED=$feed UPDATE_TEST_OUT="$out/release" UPDATE_TEST_BUILD_INFO="$out/build-info.json" \
      npx electron-builder --config "$here/electron-builder.update-test.cjs" --linux AppImage --x64 --publish never >"$logs/package-$2.log" 2>&1; then
    tail -40 "$logs/package-$2.log"; fail "packaging $2 ($1) failed"
  fi
  [ -f "$out/release/Orgtree-$1.AppImage" ] || fail "electron-builder made no Orgtree-$1.AppImage"
}
package "$vN" N
package "$vN1" N1
echo "N's packaged feed (resources/app-update.yml):"; sed 's/^/  /' "$work/N/release/linux-unpacked/resources/app-update.yml"
node "$here/check-update-feed.mjs" "$work/N1/release" "$vN1" || fail "N+1's latest-linux.yml failed its check"
cp "$work/N1/release/latest-linux.yml" "$work/N1/release/Orgtree-$vN1.AppImage" "$work/feed/"
mkdir -p "$apps"; cp "$work/N/release/Orgtree-$vN.AppImage" "$app"; chmod +x "$app"
shaN=$(sha256sum "$app" | cut -d' ' -f1); shaN1=$(sha256sum "$work/feed/Orgtree-$vN1.AppImage" | cut -d' ' -f1)
echo "installed $app (sha256 $shaN); the feed offers Orgtree-$vN1.AppImage (sha256 $shaN1)"

# The app picks systemd when `systemctl --user show-environment` succeeds for it, which runs
# with the environment the AppImage's AppRun sets up (PATH, LD_LIBRARY_PATH, ...).
step "systemctl --user show-environment, run from inside the AppImage as the app runs it"
ELECTRON_RUN_AS_NODE=1 timeout 60 "$app" -e '
  const { execFile } = require("child_process")
  for (const key of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LD_LIBRARY_PATH", "PATH"]) console.log(`  ${key}=${process.env[key] ?? "(unset)"}`)
  execFile("systemctl", ["--user", "show-environment"], { timeout: 10000 }, (error, out, err) =>
    console.log(`  exit ${error ? error.code : 0}${err ? "; stderr: " + err.trim().slice(0, 500) : ""}`))' 2>&1 | grep -v appimage_extracted || true

trap teardown EXIT
node "$here/update-feed.mjs" "$work/feed" "$port" "$logs/feed-requests.jsonl" >"$logs/feed.out" 2>&1 & feedpid=$!
Xvfb :77 -screen 0 1280x800x24 -nolisten tcp >"$logs/xvfb.out" 2>&1 & xvfbpid=$!
export DISPLAY=:77
for _ in $(seq 1 40); do [ -S /tmp/.X11-unix/X77 ] && curl -sf -o /dev/null "${feed}latest-linux.yml" && break; sleep 0.5; done
[ -S /tmp/.X11-unix/X77 ] || fail "Xvfb did not start"
curl -sf -o /dev/null "${feed}latest-linux.yml" || fail "the loopback feed did not answer"

mkdir -p "$shim_dir"
# No agent CLI on the runner, on purpose: the desktop shows its "No agent harness" notice,
# which no longer holds up start-up, so the update runs with that notice open.
for cli in claude codex agy; do if command -v "$cli" >/dev/null 2>&1; then echo "note: $cli is on PATH, so the no-harness notice will not show"; fi; done
# Every systemctl the app runs, logged with its outcome, then passed to the real one: the
# app picks systemd or the autostart fallback from `systemctl --user show-environment`.
export UPDATE_TEST_SYSTEMCTL_LOG="$systemctl_log"
cat >"$shim_dir/systemctl" <<'SHIM'
#!/bin/sh
err=$(mktemp); /usr/bin/systemctl "$@" 2>"$err"; code=$?
{ printf '%s pid %s ppid %s: systemctl %s; XDG_RUNTIME_DIR=%s DBUS_SESSION_BUS_ADDRESS=%s; exit %s; stderr: ' "$(date -u +%H:%M:%S)" "$$" "$PPID" "$*" \
  "${XDG_RUNTIME_DIR-(unset)}" "${DBUS_SESSION_BUS_ADDRESS-(unset)}" "$code"; tr '\n' ' ' <"$err"; echo; } >>"${UPDATE_TEST_SYSTEMCTL_LOG:-/dev/null}"
cat "$err" >&2; rm -f "$err"; exit "$code"
SHIM
chmod +x "$shim_dir/systemctl"; : >"$systemctl_log"
# A small shell is N's parent so that how N's desktop ends (exit code, or 128 + signal)
# is recorded in $work/N-exit; the relaunched N+1 is started by the app, not by this.
# umask 0002, as an Ubuntu session gives a user with a private group (N+1 inherits it).
launch() { (umask 0002; cd "$HOME" && setsid sh -c '"$1"; echo "$?" >"$2"' launcher "$app" "$work/N-exit" >>"$logs/app.out" 2>&1 </dev/null &); }
step "starting Orgtree $vN the way a launcher does: $app, no arguments"
# (electron-builder's AppRun adds --no-sandbox by itself where user namespaces are unavailable)
start=$SECONDS; launch
pidN=; hostN=
for _ in $(seq 1 120); do
  pidN=$(pids_of desktop | head -1); hostN=$(pids_of host | head -1)
  [ -n "$pidN" ] && [ -n "$hostN" ] && [ -n "$(engine_port)" ] && break
  sleep 1
done
[ -n "$pidN" ] || fail "Orgtree $vN did not start"
[ -n "$hostN" ] || fail "Orgtree $vN started no background engine host"
echo "running from $app (pid ppid role version):"; procs | sed 's/^/  /'
echo "the desktop's environment:"; tr '\0' '\n' <"/proc/$pidN/environ" | grep -E '^(XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|LD_LIBRARY_PATH)=' | sed 's/^/  /' || true
echo "the systemctl calls so far:"; sed 's/^/  /' "$systemctl_log"
if /usr/bin/systemctl --user is-active --quiet "$unit"; then
  manager=systemd; hostN=$(main_pid)
else
  manager=autostart
  echo "::warning::the app did not register $unit although systemctl --user works here; $([ -e "$autostart" ] && echo "it wrote $autostart" || echo "no autostart entry either") and started the host itself"
fi
[ "$(pids_of desktop | wc -l)" = 1 ] || fail "more than one desktop runs from $app: $(pids_of desktop | tr '\n' ' ')"
[ "$(version_of "$pidN")" = "$vN" ] || fail "the desktop does not run $vN"
[ "$(version_of "$hostN")" = "$vN" ] || fail "the background engine's host (pid $hostN, $manager) does not run from $app"
echo "PASS start: desktop pid $pidN and background engine host pid $hostN ($manager) run $vN; engine port $(engine_port)"
check_private "N's start"

step "waiting up to ${budget}s for the app to update itself (check, download, 60 s without input, swap, relaunch)"
deadline=$((SECONDS + budget)); swapped=; pidN1=; hostN1=; next=$((SECONDS + 30))
while [ $SECONDS -lt $deadline ]; do
  if [ -z "$swapped" ] && [ "$(sha256sum "$app" 2>/dev/null | cut -d' ' -f1)" = "$shaN1" ]; then
    swapped=$SECONDS; echo "the file at $app is N+1 now, $((SECONDS - start)) s after the start"
  fi
  if [ -n "$swapped" ]; then
    now=$(procs); desktops=$(echo "$now" | awk '$3 == "desktop"')
    if [ "$manager" = systemd ]; then
      host=; /usr/bin/systemctl --user is-active --quiet "$unit" && host=$(main_pid)
    else
      host=$(echo "$now" | awk -v v="$vN1" '$3 == "host" && $4 == v { print $1; exit }')
    fi
    # one desktop and the engine's host, both from N+1's mount, and nothing of N left running
    if [ "$(echo "$desktops" | grep -c .)" = 1 ] && [ "$(echo "$desktops" | awk '{ print $4 }')" = "$vN1" ] \
        && [ -n "$host" ] && [ "$host" != 0 ] && [ "$host" != "$hostN" ] \
        && echo "$now" | awk -v pid="$host" -v v="$vN1" '$1 == pid && $3 == "host" && $4 == v { found = 1 } END { exit !found }' \
        && ! echo "$now" | awk -v v="$vN" '$4 == v && $3 != "other" { found = 1 } END { exit !found }'; then
      pidN1=$(echo "$desktops" | awk '{ print $1 }'); hostN1=$host; break
    fi
  fi
  if [ $SECONDS -ge $next ]; then echo "  $((SECONDS - start)) s: $(update_log | tail -1)"; next=$((SECONDS + 30)); fi
  sleep 2
done
if [ -z "$pidN1" ]; then
  [ -n "$swapped" ] || fail "the app did not replace $app within ${budget}s"
  fail "after the swap, Orgtree $vN1 and its background engine did not both come back (with nothing of $vN left) within ${budget}s"
fi
echo "running from $app (pid ppid role version):"; procs | sed 's/^/  /'
echo "PASS relaunch: one desktop, pid $pidN1 (was $pidN), runs $vN1 from $app, $((SECONDS - swapped)) s after the swap"
echo "PASS background engine: host pid $hostN1 (was $hostN, $manager) runs $vN1 from $app; nothing of $vN is left running"
check_private "N+1 after the relaunch"

# How N's desktop ended. After the swap the updater quits it with app.quit(); that must be
# a clean exit (a Chromium check failing during the quit ends it with SIGTRAP: 133).
n_exit=$(cat "$work/N-exit" 2>/dev/null || echo '?')
case $n_exit in
  0) echo "PASS old desktop: Orgtree $vN's desktop exited cleanly (exit 0) after the swap" ;;
  '?') late+=("no exit status was recorded for Orgtree $vN's desktop") ;;
  *) if [ "$n_exit" -gt 128 ] 2>/dev/null; then late+=("Orgtree $vN's desktop ended by signal $((n_exit - 128)) ($(kill -l $((n_exit - 128)) 2>/dev/null)) instead of quitting cleanly")
     else late+=("Orgtree $vN's desktop exited with code $n_exit"); fi ;;
esac

code=; port_now=
for _ in $(seq 1 60); do
  port_now=$(engine_port); code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port_now/" || true)
  [ "$code" = 200 ] && break; sleep 1
done
[ "$code" = 200 ] || fail "the engine did not answer on port $port_now (HTTP $code)"
engines=$(pids_of engine)
[ -n "$engines" ] && [ -z "$(procs | awk -v v="$vN1" '$3 == "engine" && $4 != v')" ] \
  || fail "the engine process does not run from $vN1's AppImage: $(procs | awk '$3 == "engine"')"
echo "PASS engine: pid $engines runs from $vN1's AppImage and answers on 127.0.0.1:$port_now"

leftover=$(find "$apps" -maxdepth 1 -name ".Orgtree-*.update-*")
[ -z "$leftover" ] || fail "the swap left $leftover"
echo "PASS file: $app is N+1 (sha256 $shaN1), and no staged copy is left"

step "update-log.json"
update_log | tee "$logs/update-log.txt"
node -e 'const [file, app] = process.argv.slice(1)
  const log = JSON.parse(require("fs").readFileSync(file, "utf8"))
  const at = log.findLastIndex(e => e.stage === "handoff" && String(e.detail).includes("AppImage replaced in place at " + app))
  if (at < 0) { console.log("::error::no handoff record for the in-place swap of " + app); process.exit(1) }
  const after = log.slice(at + 1)
  if (!after.some(e => e.stage === "startup" && String(e.detail).includes("relaunched by the updater"))) {
    console.log("::error::no startup record from the relaunch after the swap"); process.exit(1) }
  const restart = after.findIndex(e => e.stage === "startup")
  console.log(`from the swap to ${log[at + 1 + restart]?.at ?? "?"} (the relaunch):`)
  for (const e of log.slice(at, at + 2 + restart)) console.log(`  ${e.at}  ${e.stage}  ${typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail ?? "")}`)
  const bad = after.filter(e => ["error", "not-installed", "handoff-refused", "failure-report-shown", "held"].includes(e.stage))
  if (bad.length) { console.log("::error::after the swap: " + bad.map(e => e.stage).join(", ")); process.exit(1) }
  console.log("PASS update-log.json: the swap (handoff) and the relaunch (startup), and nothing failed after them")' \
  "$profile/update-log.json" "$app" || fail "update-log.json does not show a clean update"

step "how N+1 was downloaded"
node -e 'const [file, name, size] = process.argv.slice(1)
  const requests = require("fs").readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(r => r.path === "/" + name)
  const bytes = requests.reduce((sum, r) => sum + (r.bytes ?? 0), 0)
  const ranges = requests.filter(r => r.status === 206).length, whole = requests.filter(r => r.status === 200 && r.method === "GET").length
  console.log(`${requests.length} requests for ${name}: ${ranges} ranges, ${whole} whole-file; ${bytes} of ${size} bytes sent`)
  if (whole === 0 && ranges > 0) console.log("PASS differential download")
  else console.log("::warning::not a differential download: the app fetched the whole file (the update log says why)")' \
  "$logs/feed-requests.jsonl" "Orgtree-$vN1.AppImage" "$(stat -c %s "$work/feed/Orgtree-$vN1.AppImage")"
echo "the systemctl calls the app made:"; sed 's/^/  /' "$systemctl_log"
# Where systemctl --user works (as on a Linux desktop), the background engine must be a
# systemd user unit, not the autostart fallback.
[ "$manager" = systemd ] || late+=("the app ran its background engine without systemd although systemctl --user works here (see the systemctl calls above)")
if [ ${#late[@]} -gt 0 ]; then
  for message in "${late[@]}"; do echo "::error::$message"; done
  fail "Orgtree $vN updated itself to $vN1, but ${#late[@]} check(s) failed (above)"
fi
echo "Orgtree $vN updated itself to $vN1"
