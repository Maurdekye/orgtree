#!/usr/bin/env bash
# Build a relocatable PostgreSQL for the Linux bundle from the pinned upstream source tarball.
# EDB publishes no generic Linux binaries since PG 10, so CI builds the same major/minor the
# Windows bundle ships (18.6). Dependencies are kept to glibc + zlib so one tree works in both
# the AppImage and the .deb on Ubuntu 22.04+. The engine connects over TCP without TLS and
# loads no extensions, so ICU, readline, OpenSSL, LLVM and contrib are left out.
#
# usage: build-postgres.sh <out-dir>    (out-dir gets bin/ lib/ share/)
set -euo pipefail

PG_VERSION=18.6
PG_SHA256=555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f
OUT=$(realpath -m "$1")
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

curl -fsSL --retry 3 -o "$WORK/pg.tar.bz2" \
  "https://ftp.postgresql.org/pub/source/v${PG_VERSION}/postgresql-${PG_VERSION}.tar.bz2"
echo "${PG_SHA256}  $WORK/pg.tar.bz2" | sha256sum -c -
tar -xjf "$WORK/pg.tar.bz2" -C "$WORK"
cd "$WORK/postgresql-${PG_VERSION}"

# --disable-rpath + patchelf below: the tree is moved after install, so libraries are found
# relative to each binary ($ORIGIN) rather than through the build-time prefix.
./configure --prefix="$OUT" --disable-rpath --without-icu --without-readline \
  --without-openssl --without-llvm --with-zlib >/dev/null
make -s -j"$(nproc)" >/dev/null
make -s install >/dev/null

# Drop what the engine never runs: headers, static libs, docs.
rm -rf "$OUT/include" "$OUT/share/doc" "$OUT/share/man"
find "$OUT/lib" -name '*.a' -delete

for f in "$OUT"/bin/*; do
  if file -b "$f" | grep -q ELF; then patchelf --set-rpath '$ORIGIN/../lib' "$f"; strip --strip-unneeded "$f"; fi
done
for f in "$OUT"/lib/*.so* "$OUT"/lib/postgresql/*.so; do
  [ -L "$f" ] && continue
  if file -b "$f" | grep -q ELF; then
    case "$f" in */lib/postgresql/*) rp='$ORIGIN/..' ;; *) rp='$ORIGIN' ;; esac
    patchelf --set-rpath "$rp" "$f"; strip --strip-unneeded "$f"
  fi
done

cp COPYRIGHT "$OUT/COPYRIGHT"
"$OUT/bin/postgres" --version
