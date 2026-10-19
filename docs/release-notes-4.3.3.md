# Orgtree 4.3.3

Orgtree 4.3.3 fixes problems found on fresh installations: connecting to a mail hub, the automatic first start after installing, hire options for harnesses that are not installed, and a flickering Quick chat bar on smaller screens.

## Fixes

- **Mail hubs added in Settings now connect.** A hub added through Settings was saved without the identifier Orgtree uses to register with it, so the connection test succeeded but the org never joined the hub. New hubs get an identifier when saved, and hubs saved by earlier versions are repaired automatically.
- **Mail hub discovery tries the usual ports together** when you enter an address without a port, the same way Hubchat does, and saves the one that answers. Addresses with an explicit port or URL are kept as entered.
- Mail hub connections try a direct connection first and fall back to the system proxy if that fails. The connection test follows the same route as the real connection, so a passing test means the hub can actually be reached.
- **The installer starts Orgtree reliably after a per-user install.** It no longer depends on Windows Explorer to launch the app when setup runs without administrator rights.
- **Hire options only appear for installed harnesses.** Claude, Codex and Antigravity hire tokens are hidden once Orgtree has confirmed the harness is not installed on this computer. Signed-out harnesses still appear as before.
- **The Quick chat bar keeps a stable width** on smaller screens and after resizing the window. Long org names are shortened with an ellipsis instead of pushing the controls around.

## Notes

- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
