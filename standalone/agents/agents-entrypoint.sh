#!/usr/bin/env bash
# Entrypoint of the agents image: make sure the pinned Claude Code is there,
# then run the engine (`orgtree-engine standalone` unless other arguments are
# given). With CLAUDE_CODE_INSTALL=first-start (the default image) the first
# start installs exactly the lockfile's Claude Code (npm checks every package
# against the lockfile's SHA-512) into /data/agent-tools/claude-code, on the
# data volume; later starts find it there. A failed install is reported and
# the engine starts anyway: Codex and API-key accounts still work, and the
# next start tries again.
set -uo pipefail
. /opt/orgtree/agents.env
mkdir -p "$HOME" 2>/dev/null || true

if [ "$CLAUDE_CODE_INSTALL" = first-start ]; then
  dir=/data/agent-tools/claude-code
  have="$(cat "$dir/.installed" 2>/dev/null || true)"
  if [ "$have" != "$CLAUDE_CODE_VERSION" ] || [ ! -x "$dir/node_modules/.bin/claude" ]; then
    echo "orgtree-agents: installing Claude Code $CLAUDE_CODE_VERSION (pinned by this image) into $dir" >&2
    tmp="$dir.new.$$"
    rm -rf "$tmp" && mkdir -p "$tmp" \
      && cp /opt/orgtree/claude-code/package.json /opt/orgtree/claude-code/package-lock.json "$tmp/" \
      && (cd "$tmp" && npm ci --no-fund --no-audit --cache "$tmp/.npm-cache" >&2) \
      && rm -rf "$tmp/.npm-cache" \
      && echo "$CLAUDE_CODE_VERSION" > "$tmp/.installed" \
      && rm -rf "$dir" && mv "$tmp" "$dir" \
      && echo "orgtree-agents: Claude Code $("$dir/node_modules/.bin/claude" --version 2>/dev/null | head -n1)" >&2 \
      || { rm -rf "$tmp"; echo "orgtree-agents: WARNING: could not install Claude Code $CLAUDE_CODE_VERSION; the engine starts without it and the next start tries again" >&2; }
  fi
fi

if [ $# -eq 0 ] || [ "${1#-}" != "$1" ] || [ "$1" = standalone ]; then
  exec orgtree-engine "${@:-standalone}"
fi
exec "$@"
