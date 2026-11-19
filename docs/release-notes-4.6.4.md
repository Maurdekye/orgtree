# Orgtree 4.6.4

Orgtree 4.6.4 draws every dropdown inside the app window, makes the retired badge a plain label, moves Gemini Argon and Carbon behind **Show legacy models**, gives Gemini Neon four effort levels, and adds a Linux build for arm64 machines. It still bundles Mail hub 2.4.0.

## Dropdowns

- **Drawn inside the window.** A dropdown's list now opens inside the app window instead of as a separate system pop-up, on every platform. On headsets and compositors that lost clicks on the pop-up (such as SteamOS under Gamescope), choices now register.
- **Same keys.** A closed dropdown still changes with Up, Down, Home, End and the Page keys. Enter opens it, except inside a form, where Enter submits. Escape closes the list without closing the panel behind it. Tab takes the highlighted choice and moves on.
- **Its look.** The list matches the right-click menu, marks the current choice with a tick, groups models under a small provider name, and scrolls to the window edge with the current choice in view. A closed dropdown is as wide as its current choice. Lists inside presentations and app panels open the same way. Multiple-choice lists are unchanged.

## Retired badge

- **A plain label.** The "N retired" badge on agents, projects, the org root and desks no longer reacts to clicks, so clicks reach what's underneath.
- **Open retired list (N).** The full retired list opens from the right-click menu of an agent, a project, the org root or an Agents list row. The desk's show/hide-retired switch is unchanged.

## Models

- **Argon and Carbon are legacy.** Gemini Argon now shows only with **Show legacy models** on. Gemini Carbon moves behind it too once Gemini Neon is available to your account; until then it shows as before. Existing Argon and Carbon agents keep their model. Quick chat uses a visible model when your saved choice is hidden, and restores your choice when you turn legacy models back on.
- **Neon's effort levels.** Gemini Neon offers low, medium, high and xhigh, like Hydrogen, and every Gemini model added from now on gets the same four. Whether Antigravity accepts each level for Neon hasn't been checked on a real Neon turn yet.

## Linux on arm64

- **New downloads.** An AppImage and a .deb for 64-bit ARM Linux (aarch64) sit beside the x64 ones, with their own update feed. They need glibc 2.34 or newer. They were built and smoke-tested on GitHub's arm64 runners.

## Notes

- The standalone (headless) engine ships as the Linux archive, the Docker image on this release and `ghcr.io/maurdekye/orgtree-engine:4.6.4`, plus the agents image `:4.6.4-agents`. These packages are optional: the desktop app doesn't need them. The agents image build now signs in to GitHub when it fetches GitHub's SSH host keys, so it no longer fails when anonymous requests are limited.
- Antigravity on a standalone engine: a real sign-in on a Linux engine still hasn't been checked.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
