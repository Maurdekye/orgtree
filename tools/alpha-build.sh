#!/bin/bash
# Local alpha build on D: (the SSD). Builds the release engine and the pinned
# mail hub, then runs `npm run package:win`, all in a detached build worktree
# on D:, under the machine-wide build lock and queue (team charter). E: is old
# and slow: here it holds only the git object store, the one-time seed of the
# untracked runtime inputs (SEED) and the copy of the finished installer
# (DOWNLOADS).
#
#   bash tools/alpha-build.sh <version> "<output file name>" [<git ref>]
#   bash tools/alpha-build.sh 4.2.0-alpha.5 "Orgtree Setup 4.2.0-alpha.5.exe"
#
# The version bump must already be committed at <git ref> (default
# rust-engine, resolved to one commit when the script starts): package.json,
# package-lock.json and engine/rs/orgtree-engine/Cargo.toml (Cargo.lock too:
# cargo runs --locked).
#
# Why the outputs are copied: package-preflight.mjs and electron-builder's
# extraResources read FIXED paths in the checkout
# (engine/rs/target/release/*.exe, engine/mailhub/target/release/*.exe), while
# cargo writes to the D: target folder. Those paths are emptied before every
# build and refilled only from this build, so packaging can never pick up an
# older exe. Nothing else builds the mail hub: alpha.4 shipped
# orgtree-mailhub 2.0.0 although the pinned submodule was 2.0.3.
#
# Log markers: PREP, PREP-OK, WAITING-LOCK, LOCK-TAKEN, START, ENGINE-OK,
# HUB-OK, PAYLOAD-OK, BUILD-FAILED <step>, the installer's sha256sum line,
# BUILD-DONE (DRY-RUN-DONE with DRY_RUN=1), LOCK-RELEASED or
# HANDED-TO <name> (mail that agent "build lock is yours"), BUILD-END.
#
# Settings (environment, defaults in brackets):
#   ME        [coordinator-opus]  name in the build lock and queue
#   WT        [/d/orgtree-work/worktrees/coordinator-build]  build worktree; created when missing
#   TD        [/d/orgtree-work/cargo-target/$ME]  cargo target folder (an inherited CARGO_TARGET_DIR is ignored)
#   REPO      [/e/Libraries/Desktop/orgtree]  the repository WT belongs to
#   SEED      [/e/Libraries/Desktop/orgtree/.worktrees/rust-engine]  provisioned checkout, read only
#             while WT has no engine/runtime or no PostgreSQL payload yet
#   DOWNLOADS [/e/Libraries/Downloads]
#   TMPD      [/d/orgtree-work/tmp/$ME]  TEMP/TMP for npm and electron-builder
#   LOG       [<orgtree scratch>/$ME/build-<version>.log, else $TD/build-<version>.log]
#   DRY_RUN=1 stops after the package preflight: no electron-builder, no copy

L=${BUILD_LOCK:-/d/orgtree-work/cargo-target/build.lock}
Q=${BUILD_QUEUE:-/d/orgtree-work/cargo-target/build.queue.txt}
HOLDING=0

stamp() { date -u +%FT%TZ; }
on_d() { case "$(cygpath -m "$1")" in [Dd]:/*) return 0 ;; esac; return 1; }
sha() { sha256sum < "$1" | cut -d' ' -f1; }
crate_version() { tr -d '\r' < "$1" | sed -n 's/^version = "\(.*\)"$/\1/p' | head -1; }

# cargo output -> the path the packager reads, byte-checked
place() {
  mkdir -p "$(dirname "$2")" && cp -f "$1" "$2" || return 1
  local a; a=$(sha "$1")
  [ "$a" = "$(sha "$2")" ] || { echo "copy differs from the cargo output: $2"; return 1; }
  echo "placed $2 sha256 $a"
}

# every byte against the manifest, the manifest against the pinned archive,
# the custodian sources against git (tools/postgres-layout.mjs)
check_pg() {
  (cd "$WT" && node -e "import(require('url').pathToFileURL(require('path').resolve('tools/postgres-layout.mjs'))).then(m => console.log('PostgreSQL payload verified:', JSON.stringify(m.assertPostgresRuntime(process.argv[1], { sourceRoot: '.' })))).catch(e => { console.error(e.message); process.exit(1) })" "$(cygpath -w "$1")")
}

check_runtime() {
  (cd "$WT" && node -e "import(require('url').pathToFileURL(require('path').resolve('tools/runtime-layout.mjs'))).then(m => { m.assertRuntimeLayout('engine/runtime', { label: 'engine/runtime' }); console.log('engine/runtime layout verified') }).catch(e => { console.error(e.message); process.exit(1) })")
}

# build.mjs leaves a missing input out of the hash list without a word, so
# check the list itself: this version and commit, the hub just built, and
# every input that must be hashed still matching its hash
check_build_info() {
  (cd "$WT" && node -e "
const fs = require('fs'), crypto = require('crypto')
const [version, commit, hubCommit] = process.argv.slice(1)
const info = JSON.parse(fs.readFileSync('dist/build-info.json', 'utf8'))
const need = ['dist/main/index.cjs', 'engine/mailhub/target/release/orgtree-mailhub.exe', 'engine/runtime/python.exe',
  'engine/runtime/python313._pth', 'engine/runtime/runtime-manifest.json', 'engine/postgres-runtime-manifest.json', 'engine/pg-custodian.exe']
const bad = []
if (info.version !== version) bad.push('version ' + info.version)
if (info.channel !== 'release') bad.push('channel ' + info.channel)
if (info.commit !== commit || info.dirty !== false) bad.push('commit ' + info.commit + ' dirty ' + info.dirty)
if (info.mailhubCommit !== hubCommit) bad.push('mailhubCommit ' + info.mailhubCommit)
for (const f of need) if (!info.sha256 || !info.sha256[f]) bad.push('no hash for ' + f)
for (const [f, h] of Object.entries(info.sha256 || {})) if (crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') !== h) bad.push('changed since the build: ' + f)
if (bad.length) { console.error('dist/build-info.json: ' + bad.join('; ')); process.exit(1) }
console.log('dist/build-info.json: ' + version + ' at ' + commit.slice(0, 10) + ', ' + Object.keys(info.sha256).length + ' hashed inputs, mail hub included')
" "$VERSION" "$SHA" "$(git -C "$WT/engine/mailhub" rev-parse HEAD)")
}

prep() {
  echo "PREP $(stamp) version=$VERSION out=$OUT ref=$REF commit=$SHORT me=$ME dry_run=$DRY_RUN"
  echo "worktree $(cygpath -m "$WT"), cargo target $(cygpath -m "$TD"), temp $(cygpath -m "$TMPD")"
  [ "$DRY_RUN" = 1 ] || [ -d "$DOWNLOADS" ] || { echo "no folder $DOWNLOADS"; return 1; }
  local free; free=$(df -k "$(dirname "$WT")" | awk 'NR==2 {print int($4/1048576)}')
  [ "${free:-0}" -ge 15 ] || { echo "only ${free} GB free on D:"; return 1; }

  if [ ! -e "$WT/.git" ]; then
    [ -e "$WT" ] && { echo "$WT exists but is not a git worktree"; return 1; }
    echo "creating the build worktree $(stamp)"
    git -C "$REPO" worktree add -q --detach "$(cygpath -m "$WT")" "$SHA" || return 1
  fi
  local common; common=$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir) || return 1
  [ "$(cygpath -m "$common" | tr 'A-Z' 'a-z')" = "$(cygpath -m "$REPO/.git" | tr 'A-Z' 'a-z')" ] \
    || { echo "$WT belongs to $common, not to $REPO"; return 1; }
  local dirty; dirty=$(git -C "$WT" status --porcelain --untracked-files=normal) || return 1
  [ -z "$dirty" ] || { echo "the build worktree has changes; refusing to build over them:"; echo "$dirty" | head -20; return 1; }
  git -C "$WT" -c advice.detachedHead=false checkout -q --detach "$SHA" || return 1
  git -C "$WT" submodule update -q --init engine/mailhub || return 1
  dirty=$(git -C "$WT" status --porcelain --untracked-files=normal) || return 1
  [ -z "$dirty" ] || { echo "the build worktree is not clean after the checkout:"; echo "$dirty" | head -20; return 1; }
  echo "at $(git -C "$WT" log -1 --format='%h %s' | cut -c1-100)"
  echo "mail hub $(git -C "$WT/engine/mailhub" log -1 --format='%h %s')"

  local pv lv ev
  pv=$(cd "$WT" && node -p "require('./package.json').version") || return 1
  lv=$(cd "$WT" && node -p "const l = require('./package-lock.json'); l.version + '/' + l.packages[''].version") || return 1
  ev=$(crate_version "$WT/engine/rs/orgtree-engine/Cargo.toml")
  [ "$pv" = "$VERSION" ] && [ "$lv" = "$VERSION/$VERSION" ] && [ "$ev" = "$VERSION" ] || {
    echo "version mismatch at $SHORT: wanted $VERSION; package.json $pv, package-lock.json $lv, engine Cargo.toml $ev. Commit the version bump first."
    return 1; }
  HUBV=$(crate_version "$WT/engine/mailhub/hub/Cargo.toml")
  [ -n "$HUBV" ] || { echo "no version in engine/mailhub/hub/Cargo.toml"; return 1; }

  # npm ci deletes node_modules and extracts into the same paths at once. On
  # Windows a file still held open elsewhere (a scanner) stays "delete pending",
  # the extraction into it fails with TAR_ENTRY_ERROR, and npm reports that
  # only as a warning, exit 0, files missing (measured 2026-10-10: 0 errors
  # into an empty folder, 12 over an existing one). So the old tree is moved
  # aside first and any TAR_ENTRY_ERROR fails the attempt.
  local lockhash; lockhash=$(sha "$WT/package-lock.json")
  if [ "$(cat "$WT/node_modules/.alpha-build-npm-ci" 2>/dev/null)" != "$lockhash" ]; then
    local try rc old
    for try in 1 2 3; do
      echo "NPM-CI $(stamp) attempt $try"
      old=""
      if [ -e "$WT/node_modules" ]; then
        old="$TMPD/node_modules.old.$try"
        rm -rf "$old" && mv "$WT/node_modules" "$old" || old=""
      fi
      (cd "$WT" && npm ci --no-audit --no-fund) > "$TMPD/npm-ci.log" 2>&1; rc=$?
      cat "$TMPD/npm-ci.log"
      [ -n "$old" ] && rm -rf "$old"
      if [ $rc = 0 ] && ! grep -q "TAR_ENTRY_ERROR" "$TMPD/npm-ci.log"; then
        echo "$lockhash" > "$WT/node_modules/.alpha-build-npm-ci"
        break
      fi
      echo "npm ci attempt $try failed: exit $rc, $(grep -c TAR_ENTRY_ERROR "$TMPD/npm-ci.log") TAR_ENTRY_ERROR"
      [ $try = 3 ] && return 1
    done
  fi

  # The untracked runtime inputs, once per worktree: staged from SEED with
  # their own checks, never linked (a link would read them from E: forever).
  if [ ! -e "$WT/engine/runtime" ]; then
    echo "SEED engine/runtime from $(cygpath -m "$SEED") $(stamp)"
    (cd "$WT" && node tools/stage-runtime.mjs --from "$(cygpath -w "$SEED")") || return 1
  fi
  check_runtime || return 1
  local f pg=0
  for f in postgresql pg-custodian.exe postgres-runtime-manifest.json; do [ -e "$WT/engine/$f" ] && pg=$((pg + 1)); done
  if [ $pg = 1 ] || [ $pg = 2 ]; then
    echo "partial PostgreSQL payload in $WT/engine: remove postgresql, pg-custodian.exe and postgres-runtime-manifest.json to reseed"
    return 1
  fi
  if [ $pg = 0 ]; then
    echo "SEED PostgreSQL payload from $(cygpath -m "$SEED") $(stamp)"
    local stage="$TMPD/pg-seed"
    rm -rf "$stage" && mkdir -p "$stage" || return 1
    cp -r "$SEED/engine/postgresql" "$stage/" && cp "$SEED/engine/pg-custodian.exe" "$SEED/engine/postgres-runtime-manifest.json" "$stage/" || return 1
    check_pg "$stage" || return 1
    mv "$stage/postgresql" "$stage/pg-custodian.exe" "$stage/postgres-runtime-manifest.json" "$WT/engine/" && rmdir "$stage" || return 1
  fi
  check_pg "$WT/engine" || return 1

  (cd "$WT" && node -e "
const fs = require('fs'), path = require('path')
for (const p of process.argv.slice(1)) {
  if (!fs.existsSync(p)) continue
  const real = fs.realpathSync.native(p)
  if (real.toLowerCase() !== path.resolve(p).toLowerCase()) { console.error('not a real folder of the build worktree: ' + p + ' -> ' + real); process.exit(1) }
}" node_modules engine engine/runtime engine/postgresql engine/mailhub engine/rs dist release) || return 1

  # nothing an earlier build left may reach this package
  rm -rf "${WT:?}/release" || return 1
  rm -f "$WT/engine/rs/target/release/orgtree-engine.exe" "$WT/engine/rs/target/release/orgtree-credential-broker.exe" \
    "$WT/engine/mailhub/target/release/orgtree-mailhub.exe" || return 1
  echo "PREP-OK $(stamp)"
}

build() {
  echo "LOCK-TAKEN $(stamp)"
  while [ "$(powershell -NoProfile -Command '[math]::Floor((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB)')" -lt 3 ]; do echo "RAM-WAIT $(stamp)"; sleep 30; done
  echo "START $(stamp) $SHORT"
  git -C "$WT/engine/mailhub" rev-parse --short HEAD
  export ORGTREE_RELEASE_BUILD=1 ORGTREE_BUILD_COMMIT=$SHORT CARGO_TARGET_DIR="$(cygpath -w "$TD")"
  unset ELECTRON_RUN_AS_NODE
  local out="$TD/release" eng="$WT/engine/rs/target/release" hub="$WT/engine/mailhub/target/release" v
  (cd "$WT/engine/rs" && cargo build --release --locked -j 2) || { echo "BUILD-FAILED engine $(stamp)"; return 1; }
  place "$out/orgtree-engine.exe" "$eng/orgtree-engine.exe" && place "$out/orgtree-credential-broker.exe" "$eng/orgtree-credential-broker.exe" \
    || { echo "BUILD-FAILED engine-copy $(stamp)"; return 1; }
  v=$("$eng/orgtree-engine.exe" --version | tr -d '\r')
  [ "$v" = "orgtree-engine $VERSION" ] || { echo "the engine says \"$v\", not \"orgtree-engine $VERSION\" (a release build)"; echo "BUILD-FAILED engine-version $(stamp)"; return 1; }
  grep -q -a -F "$SHORT" "$eng/orgtree-engine.exe" || { echo "the engine does not carry ORGTREE_BUILD_COMMIT=$SHORT"; echo "BUILD-FAILED engine-commit $(stamp)"; return 1; }
  echo "ENGINE-OK $(stamp) $v"
  (cd "$WT/engine/mailhub" && cargo build --release --locked -j 2) || { echo "BUILD-FAILED hub $(stamp)"; return 1; }
  place "$out/orgtree-mailhub.exe" "$hub/orgtree-mailhub.exe" || { echo "BUILD-FAILED hub-copy $(stamp)"; return 1; }
  v=$("$hub/orgtree-mailhub.exe" --version | tr -d '\r')
  [ "$v" = "orgtree-mailhub $HUBV" ] || { echo "the mail hub says \"$v\", not \"orgtree-mailhub $HUBV\" (engine/mailhub/hub/Cargo.toml)"; echo "BUILD-FAILED hub-version $(stamp)"; return 1; }
  echo "HUB-OK $(stamp) $v"

  if [ "$DRY_RUN" = 1 ]; then
    (cd "$WT" && npm run build && node tools/package-preflight.mjs) || { echo "BUILD-FAILED preflight $(stamp)"; return 1; }
    check_build_info || { echo "BUILD-FAILED build-info $(stamp)"; return 1; }
    echo "DRY-RUN-DONE $(stamp)"
    return 0
  fi
  # --publish never: a CI-looking environment must not turn a local build into a publish
  (cd "$WT" && npm run package:win -- --publish never) || { echo "BUILD-FAILED package $(stamp)"; return 1; }
  check_build_info || { echo "BUILD-FAILED build-info $(stamp)"; return 1; }
  local res="$WT/release/win-unpacked/resources/engine"
  [ "$(sha "$res/orgtree-engine.exe")" = "$(sha "$eng/orgtree-engine.exe")" ] \
    && [ "$(sha "$res/orgtree-credential-broker.exe")" = "$(sha "$eng/orgtree-credential-broker.exe")" ] \
    && [ "$(sha "$res/orgtree-mailhub.exe")" = "$(sha "$hub/orgtree-mailhub.exe")" ] \
    || { echo "the packaged engine, credential broker or mail hub differs from the one just built (stale, or re-signed by electron-builder)"; echo "BUILD-FAILED payload $(stamp)"; return 1; }
  echo "PAYLOAD-OK $(stamp) the packaged engine, credential broker and mail hub are the ones just built"
  local inst="$WT/release/Orgtree Setup $VERSION.exe"
  ls -la "$WT"/release/*.exe
  [ -f "$inst" ] || { echo "no installer at $inst"; echo "BUILD-FAILED installer $(stamp)"; return 1; }
  [ -e "$DOWNLOADS/$OUT" ] && echo "replacing $DOWNLOADS/$OUT"
  cp "$inst" "$DOWNLOADS/$OUT" || { echo "BUILD-FAILED copy $(stamp)"; return 1; }
  [ "$(sha "$DOWNLOADS/$OUT")" = "$(sha "$inst")" ] || { echo "the copy in $DOWNLOADS differs from the built installer"; echo "BUILD-FAILED copy $(stamp)"; return 1; }
  sha256sum "$DOWNLOADS/$OUT"
  echo "BUILD-DONE $(stamp)"
}

release_lock() {
  local next; next=$(grep -v '^\s*$' "$Q" 2>/dev/null | head -1 | tr -d '\r')
  if [ -z "$next" ]; then rm -rf "$L"; echo "LOCK-RELEASED $(stamp)" >> "$LOG"
  else
    echo "$next $(stamp) handed over by $ME" > "$L/owner.txt"
    sed -i "0,/^$next\r\?$/{/^$next\r\?$/d}" "$Q"
    echo "HANDED-TO $next $(stamp) (mail $next: build lock is yours)" >> "$LOG"
  fi
  HOLDING=0
}

# a TERM/INT while holding the lock still releases or hands it over (bash runs
# this after the running command, e.g. cargo, has finished)
interrupted() {
  echo "BUILD-FAILED interrupted $(stamp)" >> "$LOG"
  [ "$HOLDING" = 1 ] && release_lock
  rm -f "$RUNNING"
  echo BUILD-END >> "$LOG"
  exit 130
}

main() {
  VERSION=${1:-}; OUT=${2:-}; REF=${3:-rust-engine}
  if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || [ -z "$OUT" ] \
    || [[ "$OUT" == */* || "$OUT" == *\\* || "$OUT" != *.exe ]]; then
    echo "usage: bash tools/alpha-build.sh <version> \"<output file name>.exe\" [<git ref>]" >&2
    return 2
  fi
  ME=${ME:-coordinator-opus}
  WT=${WT:-/d/orgtree-work/worktrees/coordinator-build}
  TD=${TD:-/d/orgtree-work/cargo-target/$ME}
  REPO=${REPO:-/e/Libraries/Desktop/orgtree}
  SEED=${SEED:-/e/Libraries/Desktop/orgtree/.worktrees/rust-engine}
  DOWNLOADS=${DOWNLOADS:-/e/Libraries/Downloads}
  TMPD=${TMPD:-/d/orgtree-work/tmp/$ME}
  DRY_RUN=${DRY_RUN:-0}
  local d
  for d in "$WT" "$TD" "$TMPD"; do on_d "$d" || { echo "must be on D:: $d" >&2; return 1; }; done
  local scratch; scratch="$(cygpath -u "$APPDATA")/Orgtree v2/data/scratch/orgtree/$ME"
  if [ -z "${LOG:-}" ]; then
    if [ -d "$scratch" ]; then LOG="$scratch/build-$VERSION.log"; else LOG="$TD/build-$VERSION.log"; fi
  fi
  mkdir -p "$TD" "$TMPD" "$(dirname "$LOG")" || return 1
  RUNNING="$TD/alpha-build.pid"
  if [ -f "$RUNNING" ] && kill -0 "$(cat "$RUNNING")" 2>/dev/null; then
    echo "another alpha build for $ME is running (pid $(cat "$RUNNING"))" >&2
    return 1
  fi
  echo $$ > "$RUNNING"
  trap interrupted INT TERM HUP
  SHA=$(git -C "$REPO" rev-parse --verify -q "$REF^{commit}") || { echo "unknown git ref: $REF" >&2; rm -f "$RUNNING"; return 1; }
  SHORT=$(git -C "$REPO" rev-parse --short "$SHA")
  [ -n "${CARGO_TARGET_DIR:-}" ] && echo "ignoring the inherited CARGO_TARGET_DIR=$CARGO_TARGET_DIR" > "$LOG" || : > "$LOG"
  unset CARGO_TARGET_DIR
  export TEMP TMP
  TEMP=$(cygpath -w "$TMPD"); TMP=$TEMP
  echo "log: $LOG"

  if ! prep >> "$LOG" 2>&1; then
    echo "BUILD-FAILED prep $(stamp)" >> "$LOG"; echo BUILD-END >> "$LOG"; rm -f "$RUNNING"
    echo "alpha build $VERSION: FAILED in preparation (see the log)"
    return 1
  fi
  echo "WAITING-LOCK $(stamp)" >> "$LOG"
  tr -d '\r' 2>/dev/null < "$Q" | grep -qx "$ME" || echo "$ME" >> "$Q"
  local first
  while true; do
    if [ -f "$L/owner.txt" ] && [ "$(awk '{print $1; exit}' "$L/owner.txt")" = "$ME" ]; then break; fi
    first=$(grep -v '^\s*$' "$Q" 2>/dev/null | head -1 | tr -d '\r')
    if [ ! -d "$L" ] && { [ -z "$first" ] || [ "$first" = "$ME" ]; }; then
      mkdir "$L" 2>/dev/null && break
    fi
    sleep 20
  done
  HOLDING=1
  echo "$ME $(stamp) alpha build $VERSION at $SHORT (release engine + mail hub + package:win on D:)" > "$L/owner.txt"
  sed -i "0,/^$ME\r\?$/{/^$ME\r\?$/d}" "$Q"
  local ok=0
  build >> "$LOG" 2>&1 && ok=1
  release_lock
  rm -f "$RUNNING"
  echo BUILD-END >> "$LOG"
  if [ $ok = 1 ]; then echo "alpha build $VERSION: $( [ "$DRY_RUN" = 1 ] && echo dry run done || echo "done, $DOWNLOADS/$OUT" )"
  else echo "alpha build $VERSION: FAILED (see the log)"; fi
  [ $ok = 1 ]
}

# One line, so bash has read the whole script before the checkout in prep can
# replace this file (when it is run from the build worktree itself).
main "$@"; exit $?
