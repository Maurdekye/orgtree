# Orgtree 4.6.5

Orgtree 4.6.5 adds Claude Mythos for accounts that have it, a **Quit Orgtree** entry inside the app on every platform, a clear look for disabled dropdowns, and fixes the desk header at some widths. The `orgtree_unstick` tool is now called `orgtree_thaw`. It still bundles Mail hub 2.4.0.

## Claude Mythos

- **Shown only where you have it.** Mythos appears as a Claude model when one of your signed-in Claude accounts provides it, and stays hidden otherwise. Orgtree reads this from the model list the account's own Claude Code reports when an agent starts on it. It costs 8 credits, like Fable. If your account gained Mythos after you signed in, sign in again so its model list is current.

## Quit Orgtree

- **In the app menu, everywhere.** The app menu's last entry, **Quit Orgtree**, does what the tray's Quit does: it asks the same confirmation and stops the background service cleanly. It matters where there is no tray, such as Orgtree opened directly in the Steam overlay. Closing the window still leaves the background service running, as before.

## Look and feel

- **Disabled dropdowns look disabled.** Since 4.6.4 a disabled dropdown looked like one you could use and only ignored clicks. It now shows dim, faded text and a not-allowed cursor, like a disabled button, in every theme. Dropdowns in presentations and app panels already looked disabled and are unchanged.
- **Desk header.** At some desk widths the DND and halt buttons were drawn over the status text. The header now shortens the name first and then moves its buttons to a second row.

## Agent tools

- **`orgtree_thaw`.** The tool that releases a frozen agent is now called `orgtree_thaw`, and the desk's button and its messages say "thaw". The old name `orgtree_unstick` still works as a hidden alias, so saved watchdog actions that name it keep running. Because every agent's tool list changes, each agent starts a fresh prompt cache once after the upgrade.

## Linux AppImage without FUSE

- **Use the environment variable.** On a Steam Frame, SteamOS or any Linux without FUSE (`libfuse2`), start the AppImage with `APPIMAGE_EXTRACT_AND_RUN=1` in its environment, not with the `--appimage-extract-and-run` argument the 4.6.4 notes named. The AppImage's launcher removes the argument, so the restart after an update would try FUSE and fail to start; the variable carries over. In Steam, set the launch options to `APPIMAGE_EXTRACT_AND_RUN=1 %command%`. Keep the file at one fixed path in a folder you can write to: updates replace it in place, and the background engine's login registration names that path. See [Getting started](getting-started.md#linux-appimage-without-fuse).

## Notes

- The "Startup budget" check on GitHub works again: it failed on every branch because its workflow never built a test helper. No product change.
- The standalone (headless) engine ships as the Linux archive, the Docker image on this release and `ghcr.io/maurdekye/orgtree-engine:4.6.5`, plus the agents image `:4.6.5-agents`. These packages are optional: the desktop app doesn't need them.
- Antigravity on a standalone engine: a real sign-in on a Linux engine still hasn't been checked.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
