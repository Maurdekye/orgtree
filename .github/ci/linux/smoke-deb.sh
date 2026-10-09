#!/usr/bin/env bash
# Install the .deb with apt (as a user would), check the layout and the sandbox
# helper, start it under a virtual display, then remove it.
set -euo pipefail
out=$(realpath "$1")
logs=$(realpath -m build/linux/smoke-logs); mkdir -p "$logs"
deb=$(ls "$out"/orgtree_*_amd64.deb)
dpkg-deb --info "$deb" | sed -n '1,30p'
sudo apt-get install -y -q "$deb"
bin=$(dpkg -L orgtree | grep -m1 -E '/orgtree$' || true)
[ -n "$bin" ] || { echo "::error::no /orgtree binary in the installed package"; dpkg -L orgtree | head -40; exit 1; }
echo "installed binary: $bin"
dir=$(dirname "$bin")
stat -c '%a %U %n' "$dir/chrome-sandbox"
[ -x "$dir/resources/engine/orgtree-engine" ] || { echo "::error::engine missing from the .deb"; exit 1; }
[ -x "$dir/resources/engine/postgresql/bin/postgres" ] || { echo "::error::postgres missing from the .deb"; exit 1; }
export HOME=$(mktemp -d)
xvfb-run -a -s '-screen 0 1280x800x24' "$bin" >"$logs/deb.out" 2>&1 &
runner=$!
ok=
for _ in $(seq 1 120); do
  if find "$HOME/.config" -name engine-port.json 2>/dev/null | grep -q .; then ok=1; break; fi
  kill -0 "$runner" 2>/dev/null || break
  sleep 1
done
[ -n "$ok" ] || { echo "::error::installed app did not start its engine"; tail -80 "$logs/deb.out"; exit 1; }
sleep 10
kill -0 "$runner" 2>/dev/null || { echo "::error::installed app died"; tail -80 "$logs/deb.out"; exit 1; }
echo "installed .deb started with the sandbox enabled and its engine running"
kill -TERM "$runner" 2>/dev/null || true; pkill -TERM -f "$bin" || true; pkill -TERM -f orgtree-engine || true
for _ in $(seq 1 30); do pgrep -f orgtree-engine >/dev/null || break; sleep 1; done
pkill -KILL -f orgtree-engine || true
sudo apt-get remove -y -q orgtree
