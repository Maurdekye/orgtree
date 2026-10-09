#!/usr/bin/env bash
# Linux counterpart of tools/package-preflight.mjs (which checks the Windows layout):
# a release-stamped engine, the pinned mail hub, a relocatable PostgreSQL, and
# build-info provenance for a clean tree at HEAD.
set -euo pipefail
eng=engine/rs/target/release/orgtree-engine
hub=engine/mailhub/target/release/orgtree-mailhub
pg=build/linux/postgresql/bin

v=$("$eng" --version); echo "engine: $v"
case "$v" in *"(dev)"*) echo "::error::engine is a development build"; exit 1;; esac
h=$("$hub" --version); echo "hub: $h"
[[ "$h" =~ ^orgtree-mailhub\ [0-9] ]] || { echo "::error::not the mail hub binary"; exit 1; }
p=$("$pg/postgres" --version); echo "postgres: $p"
[[ "$p" == *" 18.6"* ]] || { echo "::error::unexpected PostgreSQL version"; exit 1; }
for t in postgres pg_ctl initdb psql pg_controldata; do [ -x "$pg/$t" ] || { echo "::error::missing $pg/$t"; exit 1; }; done
# relocatable: no library may resolve outside glibc/zlib or the tree itself
for f in "$pg"/* build/linux/postgresql/lib/*.so*; do
  file -b "$f" | grep -q ELF || continue
  if ldd "$f" | grep -q 'not found'; then echo "::error::$f has unresolved libraries"; ldd "$f"; exit 1; fi
done
echo "glibc floor of the engine: $(objdump -T "$eng" | grep -o 'GLIBC_[0-9.]*' | sort -Vu | tail -1)"

node -e '
const fs = require("fs"); const cp = require("child_process")
const info = JSON.parse(fs.readFileSync("dist/build-info.json", "utf8"))
const head = cp.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
const hub = cp.execFileSync("git", ["-C", "engine/mailhub", "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
if (info.channel !== "release") throw new Error("build-info channel " + info.channel)
if (info.commit !== head || info.dirty !== false) throw new Error("build-info does not match a clean HEAD: " + JSON.stringify({ commit: info.commit, dirty: info.dirty, head }))
if (info.mailhubCommit !== hub) throw new Error("build-info mail hub pin mismatch")
console.log("build-info:", info.version, info.commit, "hub", info.mailhubCommit)
'
