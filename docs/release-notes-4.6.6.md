# Orgtree 4.6.6

Orgtree 4.6.6 makes Orgtree links from Hubchat work on Linux. It still bundles Mail hub 2.4.0.

## Orgtree links on Linux

- **Links open on Linux.** The Linux app now registers `orgtree://` links when it starts, so Hubchat 1.3.10 or later on the same computer can open tickets, documents, agents and other mentions in Orgtree, and its Orgtree org badge works too. Orgtree adds its own hidden handler entry and leaves any launcher or default you set yourself alone.

## Notes

- The standalone (headless) engine ships as the Linux archive, the Docker image on this release and `ghcr.io/maurdekye/orgtree-engine:4.6.6`, plus the agents image `:4.6.6-agents`. These packages are optional: the desktop app doesn't need them.
- Antigravity on a standalone engine: a real sign-in on a Linux engine still hasn't been checked.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
