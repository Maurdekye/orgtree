#!/usr/bin/env bash
# Start the AppImage under a virtual display and check that the window process stays
# up and that the engine it started answers. Extract-and-run avoids needing FUSE here.
set -euo pipefail
out=$(realpath "$1")
logs=$(realpath -m build/linux/smoke-logs); mkdir -p "$logs"
app=$(ls "$out"/Orgtree-*.AppImage)
export HOME=$(mktemp -d)   # fresh profile: ~/.config/<app>/data is created by the app
export APPIMAGE_EXTRACT_AND_RUN=1
xvfb-run -a -s '-screen 0 1280x800x24' "$app" --no-sandbox >"$logs/appimage.out" 2>&1 &
runner=$!
port_file=
for _ in $(seq 1 120); do
  port_file=$(find "$HOME/.config" -name engine-port.json 2>/dev/null | head -1 || true)  # ~/.config appears only once the app runs
  [ -n "$port_file" ] && pgrep -f orgtree-engine >/dev/null && break
  kill -0 "$runner" 2>/dev/null || { echo "::error::AppImage exited"; tail -80 "$logs/appimage.out"; exit 1; }
  sleep 1
done
[ -n "$port_file" ] || { echo "::error::the app's engine never wrote engine-port.json"; tail -80 "$logs/appimage.out"; exit 1; }
echo "engine-port.json: $(cat "$port_file")"
sleep 20
kill -0 "$runner" 2>/dev/null || { echo "::error::AppImage died within 20 s of start"; tail -80 "$logs/appimage.out"; exit 1; }
pgrep -af 'orgtree-engine|postgres' | head -20
echo "AppImage stayed up with its engine running"
cp -r "$HOME/.config" "$logs/appimage-config" 2>/dev/null || true
kill -TERM "$runner" 2>/dev/null || true; pkill -TERM -f "$app" || true; pkill -TERM -f orgtree-engine || true
for _ in $(seq 1 30); do pgrep -f orgtree-engine >/dev/null || break; sleep 1; done
pkill -KILL -f orgtree-engine || true
