#!/usr/bin/env bash
# Smoke for the agents image (build-standalone-agents.yml), beside smoke.sh's
# engine checks:
#   smoke-agents.sh <image> <engine version> <claude code version> <codex version> <log dir>
# - Claude Code's package is not in the image (first-start install), only its lockfile;
# - a container on a fresh volume installs it on its first start, reports the pinned
#   version, and becomes healthy through the image's own HEALTHCHECK (no Node.js);
# - both CLIs report their pinned versions, auto-update is off, and node, npm, python3,
#   ssh (with GitHub's host keys and the accept-new default), git, curl and the docker
#   CLI are there; HOME is on the data volume;
# - a second container on the same volume reuses the install (no second download).
set -euo pipefail
image=$1 version=$2 claude=$3 codex=$4 logs=$(realpath -m "$5")
mkdir -p "$logs"
fail() { echo "::error::agents smoke: $*"; exit 1; }
vol="orgtree-agents-smoke-$$-$RANDOM" cid=''
trap 'docker rm -f $cid >/dev/null 2>&1 || true; docker volume rm $vol >/dev/null 2>&1 || true' EXIT

in_image() { docker run --rm --entrypoint "$1" "$image" "${@:2}"; }
in_image test ! -e /opt/orgtree/claude-code/node_modules || fail "Claude Code's package is in the image"
in_image grep -q '"integrity": "sha512-' /opt/orgtree/claude-code/package-lock.json || fail "no integrity-pinned lockfile"
echo "image: no Claude Code package, an integrity-pinned lockfile for $claude"

docker volume create "$vol" >/dev/null
start() {
  cid=$(docker run -d --env ORGTREE_STANDALONE_TOKEN= --health-interval 2s -v "$vol:/data" "$image")
  for _ in $(seq 1 240); do
    h=$(docker inspect -f '{{.State.Health.Status}}' "$cid")
    [ "$h" = healthy ] && return 0
    [ "$(docker inspect -f '{{.State.Running}}' "$cid")" = true ] || { docker logs "$cid" 2>&1 | tail -30; fail "the container exited"; }
    sleep 1
  done
  docker logs "$cid" 2>&1 | tail -30; fail "not healthy after 240 s (health: $h)"
}
start
started=$(docker logs "$cid" 2>&1); echo "$started" > "$logs/first-start.log"
grep -q "installing Claude Code $claude" <<<"$started" || fail "the first start did not install Claude Code $claude"
echo "first start: installed Claude Code, healthy"

x() { docker exec "$cid" "$@"; }
got=$(x claude --version); echo "claude --version: $got"
grep -q "^$claude" <<<"$got" || fail "claude says '$got', want $claude"
got=$(x codex --version); echo "codex --version: $got"
grep -q " $codex\$" <<<"$got" || fail "codex says '$got', want $codex"
got=$(x sh -c '"$ORGTREE_CODEX_BIN" --version'); grep -q " $codex\$" <<<"$got" || fail "ORGTREE_CODEX_BIN says '$got'"
got=$(x sh -c '"$ORGTREE_CLAUDE_BIN" --version'); grep -q "^$claude" <<<"$got" || fail "ORGTREE_CLAUDE_BIN says '$got'"
[ "$(x printenv DISABLE_AUTOUPDATER)" = 1 ] || fail "DISABLE_AUTOUPDATER is not 1"
[ "$(x printenv HOME)" = /data/home ] || fail "HOME is not /data/home"
x test -w /data/home || fail "HOME is not writable"
x sh -c 'test ! -w "$(dirname "$(readlink -f "$ORGTREE_CODEX_BIN")")"' || fail "Codex's install is writable (it could update itself)"
for t in "node --version" "npm --version" "python3 --version" "ssh -V" "git --version" "curl --version" "docker --version"; do
  out=$(x sh -c "$t 2>&1" | head -n1) || fail "$t failed"
  echo "$t: $out"
done
x grep -q '^github.com ssh-ed25519 ' /etc/ssh/ssh_known_hosts || fail "no GitHub host key"
x sh -c 'ssh -G example.com | grep -qi "^stricthostkeychecking accept-new"' || fail "ssh's default is not accept-new"
x orgtree-healthcheck || fail "orgtree-healthcheck failed"
[ "$(x orgtree-engine --version)" = "orgtree-engine $version" ] || fail "engine version"
docker stop -t 60 "$cid" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$cid")" = 0 ] || fail "exit status after SIGTERM is not 0"
docker rm "$cid" >/dev/null

start
again=$(docker logs "$cid" 2>&1); echo "$again" > "$logs/second-start.log"
grep -q "installing Claude Code" <<<"$again" && fail "the second start installed Claude Code again"
grep -q "^$claude" <<<"$(x claude --version)" || fail "claude after a restart"
echo "second start on the same volume: reused the install, healthy"
docker stop -t 60 "$cid" >/dev/null
echo "agents smoke passed: engine $version, Claude Code $claude, Codex $codex"
