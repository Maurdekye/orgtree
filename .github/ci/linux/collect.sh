#!/usr/bin/env bash
# Final release assets, flat, under their final names. Metadata carries a -linux
# suffix so it never collides with the Windows assets in one release.
set -euo pipefail
out=$1
v=$(node -p 'require("./package.json").version')
mkdir -p "$out"
cp "release/Orgtree-$v.AppImage" "$out/"
cp "release/orgtree_${v}_amd64.deb" "$out/"
cp dist/build-info.json "$out/build-info-linux.json"
chmod +x "$out/Orgtree-$v.AppImage"
ls -l "$out"
(cd "$out" && sha256sum *)
echo "version=$v" >> "$GITHUB_OUTPUT"
