#!/usr/bin/env bash
# After an engine was stopped with SIGTERM: its hosted mail hub must stop with it and
# leave its port free. A hub left running holds the port, and the next engine cannot
# host one there.
# Usage: hub-gone.sh <port> [seconds to wait, default 20]
port="$1" wait="${2:-20}"
hubs="" rc=""
for _ in $(seq 1 "$wait"); do
  hubs="$(ps -Ao pid=,command= | grep '[o]rgtree-mailhub' || true)"
  curl -s -o /dev/null -m 2 "http://127.0.0.1:$port/"; rc=$?
  # curl exit 7: nothing listens on the port
  if [ -z "$hubs" ] && [ "$rc" = 7 ]; then echo "the mail hub stopped with its engine; port $port is free"; exit 0; fi
  sleep 1
done
echo "::error::after SIGTERM to the engine, a mail hub still runs or port $port is still taken"
[ -z "$hubs" ] || printf 'still running:\n%s\n' "$hubs"
[ "$rc" = 7 ] || echo "port $port still answers (curl exit $rc)"
exit 1
