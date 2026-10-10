#!/usr/bin/env bash
# An Orgtree AppImage's first start, the way a stock Ubuntu desktop runs it.
#
# What decides the background engine's path on Linux, and how this reproduces it:
# - A desktop session has a D-Bus session bus. With one, the app registers its engine as
#   the systemd user unit orgtree-engine.service; without one, Electron sets
#   DBUS_SESSION_BUS_ADDRESS=disabled:. Here: a session bus at $XDG_RUNTIME_DIR/bus.
# - Ubuntu's pam_umask gives a user with a private group umask 0002, for the session and
#   for systemd --user, which hands it to every user service that sets no UMask=. The
#   runner's own user manager does exactly that (measured: its services get 0002), and
#   the desktop is started with umask 0002 too.
# Then the AppImage starts from ~/Applications with FUSE under a virtual display, with a
# stand-in agent CLI (a user has one; builds before 4.1.2 wait on a notice without one).
# It passes when the desktop attaches to its background engine and finishes starting,
# which the engine's request log shows as the desktop's /api/desktop/status polls.
#
# Modes: fresh (no Orgtree folders yet); repair (~/.config/Orgtree v2 and its data
# folder already exist as 0775, as 4.1.1 leaves them under systemd); autostart
# (`systemctl --user show-environment` fails, as where no user manager answers, so the
# app falls back to its autostart entry). With DESKTOP_CHECK_EXPECT_PRIVATE=1 (builds
# from 4.1.2 on) both folders must end 0700, the unit must carry UMask=0077, and the
# autostart mode must log why systemd was skipped. DESKTOP_CHECK_CONFIG_MODE=775 starts
# with ~/.config at that mode (as `mkdir -p` under umask 0002 leaves it) and puts the
# old mode back afterwards.
# Mode unsafe-config (builds from 4.1.3 on): ~/.config is 0775, a folder Orgtree must not
# change. The first start must refuse the engine at once and print the folder with the
# chmod that fixes it, leaving ~/.config as it was; after that printed command, a second
# start (same profile, the engine still running) must attach as usual.
#   bash .github/ci/linux/desktop-check.sh <AppImage> <logs dir> [fresh|repair|autostart|unsafe-config]
set -euo pipefail
src=$(realpath "$1"); logs=$(realpath -m "$2"); mode=${3:-fresh}; mkdir -p "$logs"
case $mode in fresh|repair|autostart|unsafe-config) ;; *) echo "unknown mode $mode"; exit 2 ;; esac
[ "$mode" = unsafe-config ] && : "${DESKTOP_CHECK_CONFIG_MODE:=775}"
strict=${DESKTOP_CHECK_EXPECT_PRIVATE:-}
uid=$(id -u); export XDG_RUNTIME_DIR="/run/user/$uid"
unit=orgtree-engine.service
profile="$HOME/.config/Orgtree v2"   # the release identity's userData
autostart="$HOME/.config/autostart/orgtree-engine.desktop"
apps="$HOME/Applications"; app="$apps/$(basename "$src")"
shims=$(mktemp -d); budget=${DESKTOP_CHECK_BUDGET:-150}
step() { echo "--- $*"; }
engine_log() { find "$profile" -path '*diagnostics/logs/*.log' -type f -print0 2>/dev/null | xargs -0 -r cat 2>/dev/null; }
mode_of() { stat -c '%a' "$1" 2>/dev/null || echo missing; }
launch() { (umask 0002; cd "$HOME" && PATH="$shims:$PATH" setsid "$app" >>"$1" 2>&1 </dev/null &); }   # <output file>
# the desktop's main process: from an AppImage mount, neither a Chromium child (--type=)
# nor the engine's host (ELECTRON_RUN_AS_NODE=1)
desktop_pids() {
  local p
  for p in $(pgrep -f 'mount_Orgtre[^/]*/orgtree' || true); do
    tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | grep -q -e '--type=' && continue
    tr '\0' '\n' <"/proc/$p/environ" 2>/dev/null | grep -qx 'ELECTRON_RUN_AS_NODE=1' && continue
    echo "$p"
  done
}
teardown() {
  set +e
  step "teardown ($mode)"
  cp -r "$profile/data/diagnostics" "$logs/app-diagnostics" 2>/dev/null
  pkill -TERM -f 'mount_Orgtre.*/orgtree( |$)' 2>/dev/null
  systemctl --user disable --now "$unit" >/dev/null 2>&1
  rm -f "$HOME/.config/systemd/user/$unit" "$autostart"; systemctl --user daemon-reload
  for _ in $(seq 1 30); do pgrep -f 'orgtree-engine|mount_Orgtre' >/dev/null || break; sleep 1; done
  pkill -KILL -f 'orgtree-engine|mount_Orgtre|orgtree-mailhub' 2>/dev/null
  [ -n "${xvfbpid:-}" ] && kill "$xvfbpid"
  [ -n "${buspid:-}" ] && { kill "$buspid"; sleep 1; rm -f "$XDG_RUNTIME_DIR/bus"; }
  [ -n "${config_was:-}" ] && chmod "$config_was" "$HOME/.config"
  rm -rf "$shims" "$app"
}

step "the session ($mode)"
systemctl --user show-environment >/dev/null 2>&1 || { echo "::error::systemd --user is not available (enable lingering first)"; exit 1; }
svc_umask=$(timeout 30 systemd-run --user --wait --pipe --quiet sh -c umask 2>&1 || true)
echo "user $(id -un) ($uid), primary group $(id -gn) ($(id -g)); this shell's umask $(umask); a user service's umask: $svc_umask"
[ "$svc_umask" = 0002 ] || echo "::warning::user services here get umask $svc_umask, not Ubuntu's 0002 for a user with a private group"
# the desktop also refuses its engine when a folder above Orgtree's own is writable by others
echo "folders above Orgtree's: $(mode_of "$HOME/.config") $HOME/.config; $(mode_of "$HOME") $HOME"
if [ -e "$profile" ]; then mv "$profile" "$logs/earlier-profile"; echo "moved an earlier profile aside"; fi
[ -e "$HOME/.config/systemd/user/$unit" ] && { echo "::error::$unit is already registered"; exit 1; }
# The session bus: the user manager's own if one answers (dbus-user-session), else a
# dbus-daemon of ours; a socket nobody answers on is a leftover and goes.
trap teardown EXIT
bus_answers() { DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus" timeout 5 busctl --user list >/dev/null 2>&1; }
if bus_answers; then echo "session bus: the one already at $XDG_RUNTIME_DIR/bus"
else
  rm -f "$XDG_RUNTIME_DIR/bus"
  dbus-daemon --session --address="unix:path=$XDG_RUNTIME_DIR/bus" --nofork --nopidfile >"$logs/dbus.out" 2>&1 & buspid=$!
  for _ in $(seq 1 20); do bus_answers && break; sleep 0.5; done
  echo "session bus: dbus-daemon --session (pid $buspid)"
fi
bus_answers || { echo "::error::no session bus answers at $XDG_RUNTIME_DIR/bus"; exit 1; }
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
# a user of Orgtree has an agent CLI
printf '#!/bin/sh\nexit 0\n' >"$shims/claude"; chmod +x "$shims/claude"
if [ "$mode" = autostart ]; then
  # where no user manager answers: the probe fails, everything else passes through
  cat >"$shims/systemctl" <<'SHIM'
#!/bin/sh
case "$*" in *show-environment*) echo "Failed to connect to bus: No such file or directory" >&2; exit 1 ;; esac
exec /usr/bin/systemctl "$@"
SHIM
  chmod +x "$shims/systemctl"
fi
if [ "$mode" = repair ]; then
  mkdir -p "$profile/data"; chmod 0775 "$profile" "$profile/data"
  echo "pre-created as 4.1.1 leaves them: $(mode_of "$profile") $profile, $(mode_of "$profile/data") $profile/data"
fi
if [ -n "${DESKTOP_CHECK_CONFIG_MODE:-}" ]; then
  config_was=$(mode_of "$HOME/.config"); chmod "$DESKTOP_CHECK_CONFIG_MODE" "$HOME/.config"
  echo "~/.config set to $(mode_of "$HOME/.config") for this start (was $config_was)"
fi
Xvfb :78 -screen 0 1280x800x24 -nolisten tcp >"$logs/xvfb.out" 2>&1 & xvfbpid=$!
export DISPLAY=:78
for _ in $(seq 1 20); do [ -S /tmp/.X11-unix/X78 ] && break; sleep 0.5; done
mkdir -p "$apps"; cp "$src" "$app"; chmod +x "$app"

problems=()
if [ "$mode" = unsafe-config ]; then
  config_set=$(mode_of "$HOME/.config")
  step "start of $app with umask 0002 and ~/.config at $config_set: refused at once, with the fix"
  want_line="unsafe folder blocks the background engine: $HOME/.config (fix: chmod g-w,o-w '$HOME/.config')"
  first=$SECONDS; launch "$logs/app-refused.out"; line=; refused_in=
  while [ $SECONDS -lt $((first + ${DESKTOP_CHECK_REFUSE_BUDGET:-60})) ]; do
    line=$(grep -m1 -F 'unsafe folder blocks the background engine:' "$logs/app-refused.out" 2>/dev/null || true)
    [ -n "$line" ] && { refused_in=$((SECONDS - first)); break; }; sleep 1
  done
  grep -E 'boot-engine descriptor|unsafe folder' "$logs/app-refused.out" | sed 's/^/app: /' || true
  if [ -z "$line" ]; then problems+=("no 'unsafe folder blocks the background engine' line within ${DESKTOP_CHECK_REFUSE_BUDGET:-60}s")
  else
    echo "refused ${refused_in} s after the start"
    case $line in *"$want_line"*) ;; *) problems+=("the line is '$line', not '$want_line'") ;; esac
  fi
  [ "$(mode_of "$HOME/.config")" = "$config_set" ] || problems+=("~/.config changed from $config_set to $(mode_of "$HOME/.config")")
  [ "$(engine_log | grep -c 'desktop REQUEST .*GET /api/desktop/status' || true)" = 0 ] || problems+=("the refused desktop polls /api/desktop/status")
  systemctl --user is-active --quiet "$unit" || problems+=("$unit is not running after the refused start")
  first_desktop=$(desktop_pids | tr '\n' ' ')
  echo "the refused desktop: pid ${first_desktop:-none}; $unit $(systemctl --user is-active "$unit" 2>&1 || true)"
  # the user's side: the printed command, then the desktop closed and started again
  fix=${line#*(fix: }; fix=${fix%)*}
  if [ -n "$line" ]; then
    echo "running the printed fix: $fix"
    sh -c "$fix" || problems+=("the printed fix failed: $fix")
    [ "$(mode_of "$HOME/.config")" = 755 ] || problems+=("after '$fix', ~/.config is $(mode_of "$HOME/.config"), not 755")
  fi
  for p in $first_desktop; do kill -TERM "$p" 2>/dev/null || true; done
  for _ in $(seq 1 20); do [ -z "$(desktop_pids)" ] && break; sleep 1; done
  left=$(desktop_pids | tr '\n' ' '); [ -z "$left" ] || { echo "::warning::killing a desktop that did not quit: $left"; kill -KILL $left 2>/dev/null || true; sleep 2; }
  if [ ${#problems[@]} -gt 0 ]; then
    echo "--- the refused start's output"; grep -v -E 'appimage_extracted|Unable to revert mtime' "$logs/app-refused.out" | tail -30
    for p in "${problems[@]}"; do echo "::error::($mode) $p"; done
    exit 1
  fi
  echo "PASS ($mode): refused ${refused_in} s after the start, naming the folder and its fix; ~/.config stayed $config_set until the printed fix made it 755"
fi

step "start of $app with umask 0002 ($mode)"
launch "$logs/app.out"
verdict=; deadline=$((SECONDS + budget))
while [ $SECONDS -lt $deadline ]; do
  if grep -q 'boot-engine descriptor rejected' "$logs/app.out" 2>/dev/null; then
    verdict="REJECTED: $(grep -m1 'boot-engine descriptor rejected' "$logs/app.out")"; break
  fi
  if engine_log | grep -q 'desktop REQUEST .*GET /api/desktop/status'; then verdict=OK; break; fi
  sleep 2
done
manager=none; unit_umask=
if systemctl --user is-active --quiet "$unit"; then
  manager=systemd; unit_umask=$(systemctl --user show "$unit" -p UMask --value 2>/dev/null)
elif [ -e "$autostart" ]; then manager=autostart; fi
echo "background engine: $manager${unit_umask:+ (unit UMask $unit_umask)}"
echo "folders: $(mode_of "$profile") $profile; $(mode_of "$profile/data") $profile/data"
grep -E 'systemd not used|data folders made private|boot-engine descriptor|unsafe folder' "$logs/app.out" | sed 's/^/app: /' || true

case $verdict in
  OK) echo "PASS ($mode): the desktop attached to its background engine and finished starting (it polls /api/desktop/status)" ;;
  REJECTED*) problems+=("the desktop refused its background engine: ${verdict#REJECTED: }") ;;
  *) problems+=("the desktop did not finish starting within ${budget}s") ;;
esac
want=systemd; [ "$mode" = autostart ] && want=autostart
[ "$manager" = "$want" ] || problems+=("the background engine is '$manager', not '$want'")
if [ -n "$strict" ]; then
  for d in "$profile" "$profile/data"; do [ "$(mode_of "$d")" = 700 ] || problems+=("$d is $(mode_of "$d"), not 700"); done
  [ "$manager" != systemd ] || [ "$unit_umask" = 0077 ] || problems+=("$unit has UMask $unit_umask, not 0077")
  [ "$mode" != autostart ] || grep -q 'systemd not used' "$logs/app.out" || problems+=("the app did not say why it skipped systemd")
fi
if [ ${#problems[@]} -gt 0 ]; then
  echo "--- $unit"; systemctl --user status "$unit" --no-pager 2>&1 | head -12 || true
  echo "--- the app's output"; grep -v -E 'appimage_extracted|Unable to revert mtime' "$logs/app.out" | tail -30
  for p in "${problems[@]}"; do echo "::error::($mode) $p"; done
  exit 1
fi
echo "PASS ($mode): engine via $manager${unit_umask:+ with UMask $unit_umask}; folders $(mode_of "$profile") and $(mode_of "$profile/data")"
