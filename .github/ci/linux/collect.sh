#!/usr/bin/env bash
# Final release assets, flat, under their final names. Metadata carries a -linux
# suffix so it never collides with the Windows assets in one release, and the arm64
# build's files carry -arm64 as well (arch.sh). The update feed (latest-linux.yml, or
# alpha-/beta-linux.yml for a prerelease; -linux-arm64.yml for arm64) is checked against
# the AppImage before it is staged.
set -euo pipefail
. "$(dirname "$0")/arch.sh"
out=$1
v=$(node -p 'require("./package.json").version')
mkdir -p "$out"
cp "release/Orgtree-$v$ARCH_SUFFIX.AppImage" "$out/"
cp "release/orgtree_${v}_$DEB_ARCH.deb" "$out/"
cp dist/build-info.json "$out/build-info-linux$ARCH_SUFFIX.json"
feed=$(node --input-type=module -e "import { linuxChannelFile } from './.github/ci/linux/update-info.mjs'; console.log(linuxChannelFile(process.argv[1], process.argv[2]))" "$v" "$LINUX_ARCH")
cp "release/$feed" "$out/"
chmod +x "$out/Orgtree-$v$ARCH_SUFFIX.AppImage"
ls -l "$out"
(cd "$out" && sha256sum *)
node .github/ci/linux/check-update-feed.mjs "$out" "$v" "$LINUX_ARCH"
echo "version=$v" >> "$GITHUB_OUTPUT"
