# Orgtree 4.1.3

Orgtree 4.1.3 tells you at once, on Linux and macOS, when a folder outside Orgtree's own keeps it from starting, and how to fix it. Nothing changed on Windows.

## Fixed

- **Linux and macOS: a folder others can write made Orgtree wait without saying why.** Orgtree only connects to its background engine when nobody else can change the folders leading to it. 4.1.2 made Orgtree's own folders private, but a folder above them, such as a `~/.config` that something created group-writable, still kept the window waiting for minutes. Orgtree now stops at once, names the folder and gives the command that fixes it, for example `chmod g-w,o-w '/home/you/.config'`. Orgtree never changes permissions outside its own folders, so the command is yours to run; then start Orgtree again.

## Downloads

- **Windows:** `Orgtree-Setup-4.1.3.exe`. Orgtree 4.0.x and 4.1.x offer this update by themselves.
- **macOS:** `Orgtree-4.1.3-arm64.dmg` or `.zip`, and **Linux:** `orgtree_4.1.3_amd64.deb` or `Orgtree-4.1.3.AppImage`. These are still prototypes (see the 4.1.0 notes) and don't update themselves yet: install the new version over the old one by hand.
- `SHA256SUMS.txt` lists the SHA-256 of every file. GitHub Actions built all of them from the tagged commit.
