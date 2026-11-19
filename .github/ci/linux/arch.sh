#!/usr/bin/env bash
# The names that differ between the two Linux builds. Sourced by the scripts beside it.
#   ORGTREE_LINUX_ARCH=x64|arm64 (the workflow sets it; without it, this machine's own).
# x64 keeps the names it always had. The arm64 build's names carry the architecture, so
# both builds' files sit side by side in one release and each AppImage finds its own
# update feed (electron-updater on arm64 asks for <channel>-linux-arm64.yml).
#   LINUX_ARCH     x64                      arm64
#   ARCH_SUFFIX    (empty)                  -arm64     Orgtree-<v>$ARCH_SUFFIX.AppImage,
#                                                      latest-linux$ARCH_SUFFIX.yml,
#                                                      build-info-linux$ARCH_SUFFIX.json
#   DEB_ARCH       amd64                    arm64      orgtree_<v>_$DEB_ARCH.deb
#   UNPACKED       release/linux-unpacked   release/linux-arm64-unpacked
if [ -z "${ORGTREE_LINUX_ARCH:-}" ]; then
  case "$(uname -m)" in
    x86_64) ORGTREE_LINUX_ARCH=x64 ;;
    aarch64) ORGTREE_LINUX_ARCH=arm64 ;;
    *) echo "::error::no Linux build for $(uname -m)"; exit 1 ;;
  esac
fi
case "$ORGTREE_LINUX_ARCH" in
  x64) ARCH_SUFFIX=''; DEB_ARCH=amd64; UNPACKED=release/linux-unpacked ;;
  arm64) ARCH_SUFFIX=-arm64; DEB_ARCH=arm64; UNPACKED=release/linux-arm64-unpacked ;;
  *) echo "::error::ORGTREE_LINUX_ARCH must be x64 or arm64, not $ORGTREE_LINUX_ARCH"; exit 1 ;;
esac
LINUX_ARCH=$ORGTREE_LINUX_ARCH
export ORGTREE_LINUX_ARCH
