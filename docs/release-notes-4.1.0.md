# Orgtree 4.1.0

Orgtree 4.1.0 lets you message your agents from your phone with Hubchat. It moves the mail hub to a new native version, and adds the first macOS and Linux builds as untested prototypes. It is also the first Orgtree release built entirely by GitHub Actions.

## New

- **Chat from your phone.** A new "Chat from your phone" panel (also in App settings › Mail hub, and "Connect your phone…" in the tray) links the free Hubchat app on your Android phone to your organization.
  - Your phone reaches this PC through Tailscale, a free private network, from anywhere, or over your home Wi-Fi. The panel finds Tailscale on this PC and helps you install it or sign in.
  - "Turn on phone access" asks once for administrator rights and adds a Windows firewall rule for the mail hub program only: for your Tailscale network, or for private networks on home Wi-Fi. Turning phone access off removes the rule.
  - In Hubchat, tap Scan setup code and scan the code the panel shows. A setup code works once, for 10 minutes, and a new code replaces the old one.
  - Linking records the trust in your organization's org.md. Unlinking restores org.md exactly as it was.
  - The panel can keep this PC awake while it's plugged in. It warns you when the PC may sleep or when your Tailscale key is about to expire.
- **Mail hub v2.** The mail hub that Orgtree hosts is now a native program that keeps its mail in Orgtree's own database. It no longer needs Python.
  - At its first start it moves the previous hub's addresses, messages and attachments into its new database, and it keeps the old file. App settings › Mail hub shows what was moved.
  - Mail stays on the hub until its owners delete it, unless you choose a number of days.
  - The hub's version is shown in Connections, in the organization inbox's mail servers, on the status bar's hub chip and in App settings › Mail hub.
- **Replies.** Agents can answer a specific message, and the answer shows which message it replies to. In the organization inbox, mail from outside senders has a Reply button, and a reply can carry files.
- **Conversation recall.** An agent can list the mail it exchanged with one correspondent (another agent, you, another organization or a person on the mail hub), newest first.
- **macOS and Linux prototypes.** Orgtree now builds for Apple Silicon Macs and for Ubuntu and Debian PCs. These are untested builds; see below.

## Improved

- **Agents and turns.**
  - An effort change reaches a Claude agent's running turn, as in 3.x.
  - Claude agents have the PowerShell tool again.
  - Editing an agent's standing notes or other startup instruction files restarts its session at its next turn, as in 3.x.
  - A fresh session starts with the agent's open docket items, so it doesn't drop work.
  - A queued model or account switch on an idle agent applies at once.
  - Top-level agents may use the Monitor and TaskStop tools.
  - A failed CLI launch is reported once, and that notice no longer wakes the agent.
  - Agents answer a person on the mail hub at that person's address, so the reply always reaches Hubchat.
  - Documents meant for you to read are presented as documents, not sent as file downloads. An agent can present a Markdown file from disk.
  - Agent teams stay flat by default. A manager goes between an agent and some of its reports only when coordinating all of them takes too much of its time.
  - A harness setting that names the CLI a tier already runs on is accepted. A real mismatch is refused with the name of that tier's CLI.
- **Cold-turn reset.** "Reset a session before a known-cold turn" now resets above 25% of the context window by default (it was 50%). An agent's own setting overrides its organization's setting key by key, as in 3.x.
- **Mail hub.**
  - Long messages from other hubs arrive whole.
  - Large files stream to and from the hub, and inbox uploads may take up to an hour.
  - A message larger than the hub allows is refused at once with the reason, instead of being retried.
  - An organization the hub has forgotten registers again by itself.
- **Usage** readings stay about a minute old while an Orgtree window is open, as in 3.x. Before, they could be 2 to 5 minutes old.
- **On the desk and canvas.**
  - Thoughts render as Markdown.
  - Presented documents you haven't opened yet are highlighted as new or updated on the desk header and the canvas chips.
  - HTML mockups open straight in their own window.
  - Popout windows keep their own colour.
  - App settings and organization settings share one layout.
  - OpenRouter favourites show their own tier letter.

## Fixed

- An agent with more than 64 waiting notices didn't start a turn for new mail (a 4.0 regression).
- An agent that was retired in the middle of a turn and then rehired could fail to start any turn.
- Outside mail waited for a halted or frozen holder of the organization inbox. It now goes to another active agent.
- The Connections switch for this computer's mail hub didn't connect anything. It adds or removes the hub again, as in 3.x.
- The docket page could fail to load when the docket changed while it was loading.

## macOS and Linux (prototypes)

These are untested builds. On GitHub's build machines they build, start their engine and the bundled PostgreSQL, start the background engine, and run hired agents that use their Orgtree tools (a stand-in plays each AI CLI). Nobody has run them on a real Mac or Linux PC yet.

- **macOS:** `Orgtree-4.1.0-arm64.dmg` or `.zip`, for Apple Silicon Macs only. The app isn't notarized, so macOS says it can't check it for malware.
  - On macOS 15 or later: click Done, open System Settings › Privacy & Security, click "Open Anyway", then open Orgtree again.
  - On older versions: right-click the app and choose Open.
- **Linux:** `orgtree_4.1.0_amd64.deb` (recommended: `sudo apt install ./orgtree_4.1.0_amd64.deb`) or `Orgtree-4.1.0.AppImage`, for x86_64 with Ubuntu 22.04 or Debian 12 or newer. The AppImage needs FUSE 2 (`libfuse2`, or `libfuse2t64` on Ubuntu 24.04).
- **Background engine:** as on Windows, the engine starts when you sign in and keeps your agents working with the Orgtree window closed: a LaunchAgent on macOS, a systemd user service on Linux (or an autostart entry where there is none). Orgtree sets it up the first time it starts and updates it if you move the app. It finds `claude`, `codex` and `agy` in their usual install folders and on the PATH your login shell sets up; if you install one in a new place, quit and reopen Orgtree.
- **Not there yet:**
  - No automatic updates: download each new version by hand.
  - No credential bridge.
  - Chat from your phone's setup uses the Windows firewall.
  - On macOS the usage board shows no Claude readings: Claude Code keeps its sign-in in the Keychain, which Orgtree doesn't read yet. Hiring Claude agents works.

Thanks to WhoReallyKnowsAnything, whose macOS (Apple Silicon) port for Orgtree 3 (pull request #3) paved the way for the Mac build.

## Downloads

- **Windows:** `Orgtree-Setup-4.1.0.exe`. Orgtree 4.0.x offers this update by itself.
- **macOS and Linux:** the prototype files above.
- `SHA256SUMS.txt` lists the SHA-256 of every file. GitHub Actions built all of them from the tagged commit.
