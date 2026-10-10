#!/usr/bin/env bash
# An Orgtree AppImage's first start, the way a stock Ubuntu desktop runs it.
#
# A bare runner differs from a desktop in two ways that decide the background engine's
# path, and this sets up both:
# - A desktop session has a D-Bus session bus. With one, the app registers its engine as
#   the systemd user unit orgtree-engine.service; without one, Electron sets
#   DBUS_SESSION_BUS_ADDRESS=disabled: and older builds fall back to an autostart entry.
#   Here: a session bus at $XDG_RUNTIME_DIR/bus, as dbus-user-session provides.
# - Ubuntu's pam_umask gives a user with a private group umask 0002, and systemd --user
#   hands its umask to every user service that sets none (systemd.exec(5), UMask=).
#   Here: UMask=0002 on the runner's user@.service, the place systemd.exec(5) names for
#   changing the umask of all of a user's services.
# Then the AppImage starts from ~/Applications with FUSE under a virtual display, with a
# stand-in agent CLI (a user has one; builds before 40c82c0 wait on a notice without
# one). It passes when the desktop attaches to the systemd-started engine and finishes
# starting, which the engine's request log shows as the desktop's /api/desktop/status
# polls; a rejected engine or a start-up that never finishes fails it.
#   bash .github/ci/linux/desktop-check.sh <AppImage> <logs dir>
set -euo pipefail
src=$(realpath "$1"); logs=$(realpath -m "$2"); mkdir -p "$logs"
uid=$(id -u); export XDG_RUNTIME_DIR="/run/user/$uid"
unit=orgtree-engine.service
profile="$HOME/.config/Orgtree v2"   # the release identity's userData
apps="$HOME/Applications"; app="$apps/$(basename "$src")"
stub="$HOME/.local/bin/claude"; made_stub=
budget=${DESKTOP_CHECK_BUDGET:-150}
step() { echo "--- $*"; }
engine_log() { find "$profile" -path '*diagnostics/logs/*.log' -type f 2>/dev/null | xargs -r cat 2>/dev/null; }
modes() { stat -c '  %a %U:%G %n' "$HOME/.config" "$profile" "$profile/data" 2>/dev/null || true; }
report() {
  echo "--- data folder modes (the desktop rejects a group- or world-writable one)"; modes
  echo "--- $unit"; systemctl --user status "$unit" --no-pager 2>&1 | head -12
  echo "--- the app's output"; grep -v -E 'appimage_extracted|Unable to revert mtime' "$logs/app.out" | tail -30
}
teardown() {
  set +e
  step "teardown"
  pkill -TERM -f "mount_Orgtre.*/orgtree( |$)" 2>/dev/null
  systemctl --user disable --now "$unit" >/dev/null 2>&1
  rm -f "$HOME/.config/systemd/user/$unit" "$HOME/.config/autostart/orgtree-engine.desktop"; systemctl --user daemon-reload
  for _ in $(seq 1 30); do pgrep -f 'orgtree-engine|mount_Orgtre' >/dev/null || break; sleep 1; done
  pkill -KILL -f 'orgtree-engine|mount_Orgtre|orgtree-mailhub' 2>/dev/null
  [ -n "$made_stub" ] && rm -f "$stub"
  [ -n "${xvfbpid:-}" ] && kill "$xvfbpid"
  [ -n "${buspid:-}" ] && kill "$buspid"
  cp -r "$profile/data/diagnostics" "$logs/app-diagnostics" 2>/dev/null
}

step "the runner as it is"
systemctl --user show-environment >/dev/null 2>&1 || { echo "::error::systemd --user is not available (enable lingering first)"; exit 1; }
echo "user $(id -un) ($uid), primary group $(id -gn) ($(id -g)), groups: $(id -Gn)"
echo "this shell's umask: $(umask); a user service's umask: $(timeout 30 systemd-run --user --wait --pipe --quiet sh -c umask 2>&1)"
echo "user@$uid.service UMask: $(systemctl show "user@$uid.service" -p UMask --value 2>&1)"
[ -e "$profile" ] && { echo "::error::$profile exists already; this check needs a first start"; exit 1; }

step "a desktop-like session: user services with umask 0002, and a session bus"
sudo mkdir -p /etc/systemd/system/user@.service.d
printf '[Service]\nUMask=0002\n' | sudo tee /etc/systemd/system/user@.service.d/90-desktop-umask.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl restart "user@$uid.service"
for _ in $(seq 1 30); do systemctl --user show-environment >/dev/null 2>&1 && break; sleep 1; done
echo "a user service's umask now: $(timeout 30 systemd-run --user --wait --pipe --quiet sh -c umask 2>&1)"
if systemctl --user start dbus.socket >/dev/null 2>&1 && [ -S "$XDG_RUNTIME_DIR/bus" ]; then
  echo "session bus: dbus-user-session's dbus.socket"
else
  dbus-daemon --session --address="unix:path=$XDG_RUNTIME_DIR/bus" --nofork --nopidfile >"$logs/dbus.out" 2>&1 & buspid=$!
  for _ in $(seq 1 20); do [ -S "$XDG_RUNTIME_DIR/bus" ] && break; sleep 0.5; done
  echo "session bus: dbus-daemon --session (pid $buspid)"
fi
[ -S "$XDG_RUNTIME_DIR/bus" ] || { echo "::error::no session bus at $XDG_RUNTIME_DIR/bus"; exit 1; }
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
if ! command -v claude >/dev/null 2>&1; then mkdir -p "$(dirname "$stub")"; printf '#!/bin/sh\nexit 0\n' >"$stub"; chmod +x "$stub"; made_stub=1; fi

trap teardown EXIT
Xvfb :78 -screen 0 1280x800x24 -nolisten tcp >"$logs/xvfb.out" 2>&1 & xvfbpid=$!
export DISPLAY=:78
for _ in $(seq 1 20); do [ -S /tmp/.X11-unix/X78 ] && break; sleep 0.5; done
mkdir -p "$apps"; cp "$src" "$app"; chmod +x "$app"
step "first start of $app"
(cd "$HOME" && setsid "$app" >>"$logs/app.out" 2>&1 </dev/null &)
verdict=; deadline=$((SECONDS + budget))
while [ $SECONDS -lt $deadline ]; do
  if grep -q 'boot-engine descriptor rejected' "$logs/app.out" 2>/dev/null; then
    verdict="REJECTED: $(grep -m1 'boot-engine descriptor rejected' "$logs/app.out")"; break
  fi
  if engine_log | grep -q 'desktop REQUEST .*GET /api/desktop/status'; then verdict=OK; break; fi
  sleep 2
done
manager=none
if systemctl --user is-active --quiet "$unit"; then manager="systemd (MainPID $(systemctl --user show -p MainPID --value "$unit"))"
elif [ -e "$HOME/.config/autostart/orgtree-engine.desktop" ]; then manager="autostart entry"; fi
echo "background engine: $manager"
report
case $verdict in
  OK) echo "PASS: on a desktop-like session the desktop attached to its background engine and finished starting (it polls /api/desktop/status)" ;;
  REJECTED*) echo "::error::the desktop refused its background engine on a desktop-like session ($verdict)"; exit 1 ;;
  *) echo "::error::the desktop did not finish starting within ${budget}s on a desktop-like session"; exit 1 ;;
esac
[ "${manager%% *}" = systemd ] || { echo "::error::the background engine is not the systemd unit on a desktop-like session ($manager)"; exit 1; }
