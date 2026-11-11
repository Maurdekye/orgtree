#!/usr/bin/env bash
# The agents image's healthcheck (no Node.js): the engine answers
# /api/desktop/alive with 200 for its token (ORGTREE_STANDALONE_TOKEN, else
# /data/standalone-token).
set -eu
token="${ORGTREE_STANDALONE_TOKEN:-}"
[ -n "$token" ] || token="$(cat "${ORGTREE_DATA:-/data}/standalone-token" 2>/dev/null)" || exit 1
exec curl -fsS -o /dev/null --max-time 4 -H "Authorization: Bearer $token" \
  "http://127.0.0.1:${ORGTREE_PORT:-7430}/api/desktop/alive"
