# Orgtree 4.6.9

Orgtree 4.6.9 makes Orgtree easier to install and run on Linux and the Steam Frame, uses the right wording on each system, and fixes Antigravity agents that hung on a tool call. It still bundles Mail hub 2.4.0.

## Linux and Steam Frame

- **Orgtree adds itself to the app menu without FUSE.** When Orgtree runs as an AppImage in extract-and-run mode (as on the Steam Frame, which has no working FUSE), it writes and repairs its own `orgtree.desktop` entry, so it appears in the menu and the SteamVR overlay and opens `orgtree://` links. It checks that the entry points to its own AppImage and never shadows a system entry.
- **A second data folder no longer takes over the startup service.** On Linux and macOS, starting Orgtree with a different data folder or profile no longer rewrites or restarts the startup service of your main org. Only your default data folder (including the folder you moved to with Data location) registers it. Run on startup is unavailable while another data folder is open.
- **New guide** for installing Orgtree and Hubchat on SteamOS and the Steam Frame.

## Wording on every system

- Settings, notices and help name the system you are on. Windows-only controls (such as the phone-access firewall rule) are hidden on Linux and macOS instead of failing there. Windows looks exactly as before.

## Antigravity agents

- **Hung tool calls stop after 5 minutes.** A file or docket tool call that never returns is stopped gently after 5 minutes, instead of the turn sitting silent for 30 minutes. The agent gets one automatic retry per turn, and the notice names the stuck tool. Commands the agent runs keep their own limit.
- **No false "stalled" report after a finished turn.** A turn whose agent answered its latest message and reported its status no longer shows as stalled when the connection drops afterwards.

## Notes

- The standalone (headless) engine ships as the Linux archive, the Docker image on this release and `ghcr.io/maurdekye/orgtree-engine:4.6.9`, plus the agents image `:4.6.9-agents`. These packages are optional: the desktop app doesn't need them.
- Antigravity on a standalone engine: a real sign-in on a Linux engine still hasn't been checked.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
