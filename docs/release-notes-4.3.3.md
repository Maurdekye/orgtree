# Orgtree 4.3.3

Orgtree 4.3.3 fixes problems found on fresh installations: connecting to a mail hub, the automatic first start after installing, hire options for harnesses that are not installed, and a flickering Quick chat bar on smaller screens.

## Fixes

- **Mail hubs added in Settings now connect.** A hub added through Settings was saved without the identifier Orgtree uses to register with it, so the connection test succeeded but the org never joined the hub. New hubs get an identifier when saved, and hubs saved by earlier versions are repaired automatically.
- **Mail hub discovery tries the usual ports together** when you enter an address without a port, the same way Hubchat does, and saves the one that answers. Addresses with an explicit port or URL are kept as entered.
- Mail hub connections try a direct connection first and use the system proxy only if the initial connection fails. The connection test follows the same route as the real connection, so a hub that passes the test is reachable the same way when Orgtree connects.
- Mail hub connections no longer follow redirects. Enter the hub's final address; a redirect is reported as an error instead of being followed, so a failed redirect can't cause a message to be sent twice.
- **The installer launches Orgtree directly after a per-user install.** When setup runs without administrator rights, it starts the app itself instead of relying on Windows Explorer, which could fail on some computers.
- **Hire options only appear for installed harnesses.** Claude, Codex and Antigravity hire tokens are hidden once Orgtree has confirmed the harness is not installed on this computer. Signed-out harnesses still appear as before.
- **Claude Code installed with its official installer is found even when its folder is not on the system PATH.** Orgtree no longer shows a false "No agent harness was detected" message at startup in that case.
- **The Quick chat bar sizes itself more steadily** on smaller screens and after resizing the window, so its width no longer depends on earlier window sizes. Long org names are shortened with an ellipsis instead of pushing the controls around.

## Notes

- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
