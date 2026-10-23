# Operation, accounts and privacy

[Project overview](../README.md) · [Getting started](getting-started.md) · [Collaboration](collaborating.md) · [Operation and privacy](operating-orgtree.md) · [Development](development.md)

## Updates and background operation

Right-click Orgtree's **system-tray icon** to check for updates, see download progress and choose **Update now** when the download is ready. The update can be completed from that menu.

**Automatic updates** are on by default where the installation supports unattended updates. Turn them off in the tray menu or **App settings > Runtime** to stop background checks and idle installation. Manual update controls remain available. A download already in progress may finish; an installation already started completes.

The tray also provides organization navigation and controls for startup and **Exit on close**. With Exit on close disabled, closing the last window keeps the desktop available in the background; open it again from the tray. With it enabled, the desktop exits when its last visible window closes. On an all-users Windows installation, the separate background engine is not stopped by closing or quitting the desktop.

On an all-users Windows installation, **Run on boot** starts the background engine in Windows Session 0. A sign-in helper runs agent turns in your signed-in session when available; at sign-out, interrupted work resumes in Session 0. On per-user installations, the startup control is **Run on sign-in**. Turning automatic startup off prevents future automatic starts; it does not stop an engine already running or prevent an explicit start or recovery. See the [desktop runtime reference](skills/orgtree-app/app-settings/app-runtime-desktop/SKILL.md).

## Account fallback

In an org's **Settings > Autonomy**, you can allow agents to switch to another
account after a usage limit. It is off by default. Each agent's settings can
follow the org default or override it. A switch keeps the replacement account.
Claude, Codex and Muse subscription profiles with verified capacity qualify; Antigravity
cannot select a separate account for a turn. Eligible metered API keys are considered only when the provider's separate API-key fallback policy permits them. Switching changes the account/cache namespace; Codex and Muse start new sessions. The existing frozen-turn replay continues
the interrupted task. Usage checks can refresh a registered profile's sign-in credentials when needed.

## Data and privacy

In the desktop installation, the engine runs locally, and organization data and retained history are stored on your machine in its bundled database. The database listens on the local loopback interface. A standard Windows installation keeps Orgtree's data under **`%APPDATA%\Orgtree v2\data`**. Account profiles can also use provider-specific locations.

Agent requests still go to the providers you configure. Local storage does not mean model inference happens offline. Folder and tool permissions are worth choosing deliberately, just as they are when running the provider's coding tool directly.

Using a mail hub sends the messages and files you route through it to that hub; its operator can read the mail it stores. A self-hosted model server may also run on another machine. Choose those endpoints according to where you intend the work to go.
