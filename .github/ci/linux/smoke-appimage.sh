#!/usr/bin/env bash
# Start the AppImage under a virtual display and check that the window process stays
# up and that the engine it started answers. Extract-and-run avoids needing FUSE here.
set -euo pipefail
out=$(realpath "$1")
logs=$(realpath -m build/linux/smoke-logs); mkdir -p "$logs"
app=$(ls "$out"/Orgtree-*.AppImage)
# On failure: the app's output (minus the AppImage's extraction listing), any
# engine-port.json anywhere it could have gone, the engine processes and the engine's own logs.
diag() {
  grep -v appimage_extracted "$1" | tail -80 || true
  echo "--- engine-port.json candidates"; find "$HOME" /home /tmp -name engine-port.json 2>/dev/null || true
  echo "--- processes"; pgrep -af 'orgtree|postgres' || true
  find "$HOME" -path '*diagnostics/logs/*' -type f 2>/dev/null | while read -r f; do echo "--- $f"; tail -40 "$f"; done
  cp -r "$HOME/.config" "$logs/$(basename "$1" .out)-config" 2>/dev/null || true
}
export HOME=$(mktemp -d)   # fresh profile: ~/.config/<app>/data is created by the app
export XDG_CONFIG_HOME="$HOME/.config"   # Electron takes userData from here when set
export APPIMAGE_EXTRACT_AND_RUN=1
xvfb-run -a -s '-screen 0 1280x800x24' "$app" --no-sandbox >"$logs/appimage.out" 2>&1 &
runner=$!
port_file=
for _ in $(seq 1 120); do
  port_file=$(find "$HOME/.config" -name engine-port.json 2>/dev/null | head -1 || true)  # ~/.config appears only once the app runs
  [ -n "$port_file" ] && pgrep -f orgtree-engine >/dev/null && break
  kill -0 "$runner" 2>/dev/null || { echo "::error::AppImage exited"; diag "$logs/appimage.out"; exit 1; }
  sleep 1
done
[ -n "$port_file" ] || { echo "::error::the app's engine never wrote engine-port.json"; diag "$logs/appimage.out"; exit 1; }
echo "engine-port.json: $(cat "$port_file")"
code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$(grep -o "[0-9]*" "$port_file" | head -1)/" || true); echo "GET / -> $code"; [ "$code" = 200 ] || { echo "::error::the app's engine did not answer"; diag "$logs/appimage.out"; exit 1; }
sleep 20
kill -0 "$runner" 2>/dev/null || { echo "::error::AppImage died within 20 s of start"; diag "$logs/appimage.out"; exit 1; }
pgrep -af 'orgtree-engine|postgres' | head -20
echo "AppImage stayed up with its engine running"
echo "--- updater lines in the app output (none expected: Linux has no update feed)"; grep -iE "updater|app-update|latest-linux" "$logs/appimage.out" | grep -v appimage_extracted | head -20 || true
cp -r "$HOME/.config" "$logs/appimage-config" 2>/dev/null || true
kill -TERM "$runner" 2>/dev/null || true; pkill -TERM -f "$app" || true; pkill -TERM -f orgtree-engine || true
for _ in $(seq 1 30); do pgrep -f orgtree-engine >/dev/null || break; sleep 1; done
pkill -KILL -f orgtree-engine || true
