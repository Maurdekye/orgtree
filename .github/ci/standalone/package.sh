#!/usr/bin/env bash
# The standalone engine's Linux archive:
#   orgtree-engine-standalone-<v>-linux-x86_64.tar.gz
#     orgtree-engine-standalone-<v>-linux-x86_64/{orgtree-engine,README.md,LICENSE,THIRD_PARTY_NOTICES.md}
# Usage: package.sh <engine binary> <version> <source checkout> <tools dir> <out dir>
# The README comes from <tools dir>/standalone/RELEASE-README.md (the workflow's own
# revision, so a backfill of an older tag still gets it); LICENSE and the notices come
# from the source checkout. The tarball is reproducible: sorted names, fixed owner, the
# source commit's time as every mtime, gzip without a name or timestamp.
set -euo pipefail
bin=$1 version=$2 src=$3 tools=$4 out=$5
name="orgtree-engine-standalone-$version-linux-x86_64"
stage=$(mktemp -d)
mkdir -p "$stage/$name" "$out"
install -m 0755 "$bin" "$stage/$name/orgtree-engine"
# text files check out with CRLF (.gitattributes): ship them with Unix line ends
sed "s/@VERSION@/$version/g" "$tools/standalone/RELEASE-README.md" | tr -d '\r' > "$stage/$name/README.md"
tr -d '\r' < "$src/LICENSE" > "$stage/$name/LICENSE"
if [ -f "$src/THIRD_PARTY_NOTICES.md" ]; then tr -d '\r' < "$src/THIRD_PARTY_NOTICES.md" > "$stage/$name/THIRD_PARTY_NOTICES.md"; fi
chmod 0644 "$stage/$name"/*.md "$stage/$name/LICENSE"
mtime="@$(git -C "$src" log -1 --format=%ct HEAD)"
tar -C "$stage" --sort=name --owner=0 --group=0 --numeric-owner --mtime="$mtime" -cf - "$name" | gzip -n -9 > "$out/$name.tar.gz"
tar -tvzf "$out/$name.tar.gz"
sha256sum "$out/$name.tar.gz"
rm -rf "$stage"
