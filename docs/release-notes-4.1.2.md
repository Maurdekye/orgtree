# Orgtree 4.1.2

Orgtree 4.1.2 fixes the Linux prototype's start-up with its background engine. On macOS, Orgtree's data folder is now created private to you as well. Nothing changed on Windows.

## Fixed

- **Linux: Orgtree could hang at start-up.** Where new folders are group-writable by default, as on Ubuntu for most users, the background engine created Orgtree's data folder that way. Orgtree then refused that engine as unsafe, and its window never finished starting. Orgtree now keeps its data folders private to you (0700). A folder an earlier version left group-writable is repaired at the next start.
- **Linux: the background engine runs under systemd in more sessions.** In a session without a D-Bus session bus, Orgtree used to fall back to an autostart entry; it now reaches systemd there as well. When it does fall back, its output says why.

## Downloads

- **Windows:** `Orgtree-Setup-4.1.2.exe`. Orgtree 4.0.x and 4.1.x offer this update by themselves.
- **macOS:** `Orgtree-4.1.2-arm64.dmg` or `.zip`, and **Linux:** `orgtree_4.1.2_amd64.deb` or `Orgtree-4.1.2.AppImage`. These are still prototypes (see the 4.1.0 notes) and don't update themselves yet: install the new version over the old one by hand.
- `SHA256SUMS.txt` lists the SHA-256 of every file. GitHub Actions built all of them from the tagged commit.
