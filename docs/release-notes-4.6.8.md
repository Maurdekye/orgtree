# Orgtree 4.6.8

Orgtree 4.6.8 lets Orgtree on Linux see that desktop Hubchat is installed. It still bundles Mail hub 2.4.0.

## Hubchat on Linux

- **Orgtree on Linux sees desktop Hubchat.** Until now, Orgtree on Linux (such as a Steam Frame or Steam Deck) always treated Hubchat as not installed, so outside address links couldn't open their chat in Hubchat. Orgtree now counts Hubchat as installed when a working `hubchat://` link handler is registered. Hubchat 1.3.11 registers one by itself when it starts. macOS detection is not available yet.

## Notes

- The standalone (headless) engine ships as the Linux archive, the Docker image on this release and `ghcr.io/maurdekye/orgtree-engine:4.6.8`, plus the agents image `:4.6.8-agents`. These packages are optional: the desktop app doesn't need them.
- Antigravity on a standalone engine: a real sign-in on a Linux engine still hasn't been checked.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
