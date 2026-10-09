#!/usr/bin/env bash
# PNG icons for Linux (Electron cannot read .ico off Windows):
#   build/linux/icons/<n>x<n>.png       app icon set for electron-builder (from the SVG)
#   build/linux/runtime-icons/*.png     window + tray icons the app loads at runtime,
#                                       same base names as the Windows .ico files
set -euo pipefail
A=apps/desktop/assets
mkdir -p build/linux/icons build/linux/runtime-icons
for n in 16 24 32 48 64 128 256 512; do
  rsvg-convert -w "$n" -h "$n" "$A/orgtree-eye.svg" -o "build/linux/icons/${n}x${n}.png"
done
cp build/linux/icons/256x256.png build/linux/runtime-icons/orgtree-eye.png
tmp=$(mktemp -d)
for ico in "$A"/orgtree-eye-tray-*.ico; do
  base=$(basename "$ico" .ico)
  # take the largest frame of the .ico, then scale to a tray-friendly 32px
  convert "$ico" "$tmp/$base-%d.png"
  big=$(ls -S "$tmp/$base"-*.png | head -1)
  convert "$big" -resize 32x32 "build/linux/runtime-icons/$base.png"
done
rm -rf "$tmp"
ls -l build/linux/runtime-icons
