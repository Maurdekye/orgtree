# Orgtree 4.1.1

Orgtree 4.1.1 updates the mail hub that Orgtree hosts to version 2.0.1. Nothing else changed.

## Improved

- **Mail hub 2.0.1.** Orgtree 4.1.0 shipped a 2.0.0 hub. Version 2.0.1 adds two things Hubchat 1.0.0 uses:
  - **A new phone is ready at once.** A newly linked device starts from now and loads older messages as you scroll back. With the 2.0.0 hub it first downloaded every message.
  - **The relay-only door's address.** The hub now tells Hubchat on your PC where its relay-only door listens (the address phones connect to), so Hubchat no longer has to guess the port for its setup code.

## Downloads

- **Windows:** `Orgtree-Setup-4.1.1.exe`. Orgtree 4.0.x and 4.1.0 offer this update by themselves.
- **macOS:** `Orgtree-4.1.1-arm64.dmg` or `.zip`, and **Linux:** `orgtree_4.1.1_amd64.deb` or `Orgtree-4.1.1.AppImage`. These are still prototypes (see the 4.1.0 notes) and don't update themselves yet: install the new version over the old one by hand.
- `SHA256SUMS.txt` lists the SHA-256 of every file. GitHub Actions built all of them from the tagged commit.
