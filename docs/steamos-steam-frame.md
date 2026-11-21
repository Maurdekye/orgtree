# SteamOS and Steam Frame

[Documentation](../README.md#documentation) · [Getting started](getting-started.md#linux-appimage-without-fuse)

This guide covers installing and running **Orgtree** on SteamOS systems without FUSE, including the **Steam Frame** (`aarch64` SteamOS Holo 0.6.0, SteamVR Gamescope session). Run `uname -m` to pick the matching architecture: the Steam Frame is `aarch64` (`arm64`), while the Steam Deck is `x86_64` (untested on Deck; the same AppImage extract-and-run rules apply where FUSE is absent).

Linux desktop builds remain prototypes.

## What you still do by hand

1. **Download and verify the AppImage.**
   Get the Linux AppImage (Orgtree 4.6.9 or later for the automated desktop integration described below) for your architecture from [Orgtree releases](https://github.com/Maurdekye/orgtree/releases/latest) (`Orgtree-<version>-arm64.AppImage` on Steam Frame, `Orgtree-<version>.AppImage` on `x86_64`) together with the matching `latest-linux-arm64.yml` or `latest-linux.yml` from the same release. Check the file size and base64 SHA-512 digest against the YAML:

   ```sh
   orgtree_download="$HOME/Downloads/Orgtree-4.6.9-arm64.AppImage"
   file "$orgtree_download"
   wc -c < "$orgtree_download"
   openssl dgst -sha512 -binary "$orgtree_download" | openssl base64 -A
   printf '\n'
   ```

2. **Place it at a fixed, writable, space-free path.**
   In-place updates overwrite the AppImage at its original path, and Gamescope's `xdg-open` needs a plain path without spaces or shell metacharacters. If replacing an existing file by hand, quit Orgtree first and keep a backup.

   ```sh
   mkdir -p "$HOME/Applications"
   install -m 755 "$orgtree_download" "$HOME/Applications/Orgtree.AppImage"
   ```

3. **Run the first launch in extract-and-run mode.**
   Start Orgtree with `APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1` in its environment (do **not** use the `--appimage-extract-and-run` argument, which the AppImage launcher strips on updater relaunch; `NO_CLEANUP=1` keeps a second launch from deleting the running instance's extraction folder):

   ```sh
   APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 "$HOME/Applications/Orgtree.AppImage"
   ```

   If launching from Steam instead of a terminal, add the AppImage as a non-Steam game and set its launch options to `APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 %command%`.

## What Orgtree automates after first launch

Once started in extract-and-run mode (`APPIMAGE` pointing at the AppImage file and an extracted `APPDIR`), Orgtree manages its own per-user desktop integration automatically on every start:

- **App-list entry (`~/.local/share/applications/orgtree.desktop`) and icon:** creates or updates its own visible desktop entry with `Exec=env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 /path/to/Orgtree.AppImage %U` (bare unquoted path when plain) and installs its PNG icon if none exists. Orgtree marks entries it created with `X-Orgtree-Version=` and only repairs or updates those; any hand-written `orgtree.desktop` without that marker, or any entry under another filename, is left untouched.
- **`orgtree://` link handler (`~/.local/share/applications/dev.orgtree.link.desktop` and `~/.config/mimeapps.list`):** registers `x-scheme-handler/orgtree` with `env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1` and a bare path so links from Hubchat open cleanly without deleting the running app's extraction directory. Existing user defaults in `mimeapps.list` are never overwritten.
- **In-place updates:** because `APPIMAGE` still names the original file, automatic updates replace the AppImage at the same path and relaunch in extract-and-run mode.

After the first launch, you can open **Orgtree** directly from the SteamVR overlay or desktop app list.

## Verify the background engine

Orgtree's persistent engine runs from `~/.config/Orgtree v2/engine-runtime/<version>-<commit>/engine/orgtree-engine`. When systemd user units are reachable, `orgtree-engine.service` should point there; otherwise check `~/.config/autostart/orgtree-engine.desktop`.

A nested Plasma shell can set `XDG_RUNTIME_DIR` to a nested subdirectory and make a healthy user unit look unreachable. Probe against the canonical runtime directory when diagnosing:

```sh
env -u DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR="/run/user/$(id -u)" \
  systemctl --user show orgtree-engine.service -p ActiveState -p ExecStart

for pid in $(pgrep -u "$(id -u)" -x orgtree-engine); do
  readlink "/proc/$pid/exe"
done
if [ -f "$HOME/.config/autostart/orgtree-engine.desktop" ]; then
  grep '^Exec=' "$HOME/.config/autostart/orgtree-engine.desktop"
fi
```

Keep `engine-runtime` under Orgtree's management. If an engine starts without finding a CLI such as `codex` or `claude`, check whether that tool's install folder (for example `~/.local/bin`) is on the service's `PATH`.

## Cross-app links and Hubchat on SteamOS

When using Orgtree alongside [Hubchat](https://github.com/Maurdekye/orgtree-hubchat), each app registers its own hidden URI handler (`dev.orgtree.link.desktop` for `orgtree://`, `dev.orgtree.hubchat.link.desktop` for `hubchat://`). You can verify both defaults:

```sh
xdg-mime query default x-scheme-handler/orgtree
xdg-mime query default x-scheme-handler/hubchat
```

If `desktop-file-validate` is installed, you can also validate both visible and hidden `.desktop` entries under `~/.local/share/applications/`.

### Hubchat identity storage boundary without a Secret Service

The stock SteamVR Gamescope session has no `org.freedesktop.secrets` Secret Service keyring. In Hubchat 1.3.12 or later, when Hubchat confirms that no Secret Service is owned or activatable on the session bus, Hubchat falls back to storing its identity key in a user-owned private file (`~/.local/share/dev.orgtree.hubchat/identity-store/identity.key`, directory `0700`, file `0600`, no passphrase) and shows that state in **Settings › Privacy** and **Settings › Devices**.

**Security boundary:** file permissions isolate that key file from other OS users, **not** from other processes running under your own user account — anything running as the same user can read it. Hubchat never uses this fallback while a Secret Service is available (even if empty, locked, or returning an error). If a Secret Service becomes available later (such as switching to SteamOS Desktop Mode with KWallet), Hubchat does not silently migrate the file and refuses to attach a conflicting keyring identity to another profile's chats: if the keyring holds no key or a different identity than the local profile, Hubchat keeps your chats and both keys intact and prompts on the lost-key screen so you can decide; if the keyring holds the matching identity, Hubchat starts with it and cleans up the matching permissions-only file. Keep your Hubchat recovery words backed up. See Hubchat's `docs/steamos-steam-frame.md` for full Hubchat setup details.
