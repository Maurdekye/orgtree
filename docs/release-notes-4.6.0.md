# Orgtree 4.6.0

Orgtree 4.6.0 lets you open an organization from another computer: from a standalone engine, or from another desktop that shares it with you. It also adds a **Data location** setting that moves Orgtree's data folder for you, a Files panel for remote organizations, and native folder dialogs for organizations on this computer. Hiring now picks an account that can run the model. It still bundles Mail hub 2.4.0 and works with Hubchat 1.3.5.

## Remote organizations

- **Open a standalone engine's organizations.** On the Homepage choose **Add a remote engine...** and enter the engine's address and a token. Its organizations are listed below this computer's own, under a heading for each engine. Click the heading, or right-click it, for **Connection details**, **Retry now**, **Disconnect**/**Connect** and **Remove**. An address without a port gets 7430. The engine must be 4.5.11 or later.
- **Share an organization with another computer.** In an organization's settings > **Connections**, **Let other computers open this organization** shares it. **Add a computer...** gives a one-time code (one use, 15 minutes) and a line to send with **Copy both**. The group lists the computers that have the organization, each with **Revoke**, which asks first. Windows asks for administrator approval to add the firewall rules; if they go missing, the group says **Windows Firewall is blocking this** and offers **Allow**. Adding a computer is like giving it SSH access to yours: add only computers and people you would trust with your whole computer.
- **Where it listens.** App settings > **Remote access** has a switch for each place: **Tailscale** (on at first), **This private network** and **This computer only**, the last for an SSH tunnel or a local https proxy. It never listens on a public address by itself. The page also shows the port, the shared organizations and **Stop all remote access**.
- **In a remote window.** What belongs to the other computer says so: its folders aren't opened on this one, the folder picker browses the other computer's disk, and provider sign-ins happen there. App settings shows that computer's settings, read-only. While it can't be reached, the window says it's offline, keeps what you typed in the composer and reconnects by itself. When a token is revoked, **Replace token** in Connection details takes a new one. The tray list marks remote organizations, and Streamer mode hides this computer's name in Connection details.
- **Files panel.** In a remote window, the scratch folder entries (an agent's, its team's and the shared one) open a Files panel for that folder on the other computer. Open folders, **Download** a file or a whole folder (as a zip), and **Upload files**. A name that's already there asks **Replace**, **Keep both** or **Skip**. An engine without this panel says it needs updating.
- **Several people in one organization.** Each computer's actions carry its name ("User · name"). A save is refused if someone else changed the same setting first; the message says who, and keeps what you typed.

## Data location

- **Choose where Orgtree keeps its data.** App settings > Runtime > **Data location** shows the current folder and its size. **Change location...** moves the data for you. Orgtree checks the target and the free space, lists any folders it can't read (**Move without them**), stops running turns and its engine, and copies everything in a progress window with **Cancel**. Then it starts on the new folder and reopens your windows.
- **Files another program keeps writing.** After Orgtree's own processes stop, it watches the old folder for about 12 seconds and lists any file still changing, with **Continue anyway** or **Cancel**. Each file is copied once, as it is when it's read.
- **The old folder.** It's kept unless you tick **Delete old folder**; **Delete previous folder** removes it later. A failed copy or a full or unwritable target puts everything back as it was. Every step goes to a move log, reachable from **Open move log**.
- **A missing drive at startup.** If the data folder's drive is missing, Orgtree asks whether to **Retry**, choose a folder (**Choose folder...**), **Use default location** or **Quit**, instead of starting with an empty database.

## Hiring and accounts

- **An account that can run the model.** The hire form starts on an account that can run the chosen model: the organization's default when it can, otherwise the one with the most room. A tile is offered when a signed-in registered account can run it, and greyed when every signed-in account is at its limit for the model.
- **Metered keys.** When only a metered key can run the model, nothing is picked and the draft card says **choose account**. The hire waits for your choice.
- **The Fable bar.** Past the Fable pip, the part of the Fable bar that can no longer be used shows in red.

## Desktop

- **Native folder dialogs.** For organizations on this computer, folder fields open Windows' own folder dialog.
- **Swap edge.** With one side of the Attention view hidden, the divider's menu offers **Swap edge**.
- **Claude Waves.** Claude Waves wakes again when the window becomes visible, and falls back to a working graphics mode on PCs where the low-power one fails.
- **Drive roots.** A data folder directly below a drive's root on a drive other than C: (also a SUBST or mapped drive letter) no longer makes the window and the sign-in helper refuse to trust Orgtree's own files there.

## Untested

- The remote features were tested with synthetic organizations on one PC (Tailscale, loopback and tunnel addresses), not between two separate computers on a real network.
- Data location was tested hands-on with real moves of the user's own data folder between drives.

## Notes

- One database change: the engine records which computer each user action came through.
- The standalone (headless) engine ships again as the Linux archive, the Docker image on this release and `ghcr.io/maurdekye/orgtree-engine:4.6.0`, plus the agents image `:4.6.0-agents`. These packages are optional: the desktop app doesn't need them.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
