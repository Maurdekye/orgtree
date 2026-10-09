#!/usr/bin/env bash
# Final release assets, flat, under their final names. Metadata carries a -linux
# suffix so it never collides with the Windows assets in one release. The update feed
# (latest-linux.yml, or alpha-/beta-linux.yml for a prerelease) is checked against the
# AppImage before it is staged.
set -euo pipefail
out=$1
v=$(node -p 'require("./package.json").version')
mkdir -p "$out"
cp "release/Orgtree-$v.AppImage" "$out/"
cp "release/orgtree_${v}_amd64.deb" "$out/"
cp dist/build-info.json "$out/build-info-linux.json"
feed=$(node --input-type=module -e "import { linuxChannelFile } from './.github/ci/linux/update-info.mjs'; console.log(linuxChannelFile(process.argv[1]))" "$v")
cp "release/$feed" "$out/"
chmod +x "$out/Orgtree-$v.AppImage"
ls -l "$out"
(cd "$out" && sha256sum *)
node .github/ci/linux/check-update-feed.mjs "$out" "$v"
echo "version=$v" >> "$GITHUB_OUTPUT"
