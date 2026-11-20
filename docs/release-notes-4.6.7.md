# Orgtree 4.6.7

Orgtree 4.6.7 fixes Orgtree links on SteamOS and lets Hubchat open remote orgs. It still bundles Mail hub 2.4.0.

## Orgtree links on Linux

- **Orgtree links open on SteamOS.** In 4.6.6, tapping an Orgtree link in Hubchat did nothing on SteamOS (a Steam Frame or a Steam Deck in Gaming Mode), because the system misread the quoted path in Orgtree's link handler. Orgtree now writes that path without quotes when it has no spaces or special characters, and corrects the entry 4.6.6 wrote the next time it starts.

## Remote orgs in Hubchat

- **Hubchat opens remote orgs in Orgtree.** An org you connected to as a remote org now counts as one this PC's Orgtree can open: in desktop Hubchat its **Orgtree org** badge in Contact info and the Orgtree chips in its messages open in Orgtree, as they do for orgs that run on this PC. Until now they stayed grey, because Orgtree listed only its own orgs for Hubchat. If the org's name on this PC differs from its name on its own computer, the badge opens but its chips stay display-only for now.

## Notes

- The standalone (headless) engine ships as the Linux archive, the Docker image on this release and `ghcr.io/maurdekye/orgtree-engine:4.6.7`, plus the agents image `:4.6.7-agents`. These packages are optional: the desktop app doesn't need them.
- Antigravity on a standalone engine: a real sign-in on a Linux engine still hasn't been checked.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
