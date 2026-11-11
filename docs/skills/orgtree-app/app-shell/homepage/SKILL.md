---
name: orgtree-homepage
description: Find, open, filter, or create organizations from the homepage.
---

Up: [orgtree-app-shell](../SKILL.md)

# Homepage

The homepage lists organizations and offers Create new organization and the phone connection card. Opening an organization focuses its existing main window when one is already open; otherwise it opens that organization's window.

When there are more than six organizations, the filter matches names and slugs without case sensitivity. Rows show hired and active agent counts, an already-open indicator where applicable, and a removal button. Active means currently running, rather than an agent's last reported working status.

The attention badge combines open questions, unread urgent mail, and flagged work items. It replaces the activity spinner and caps its displayed value at 99+. Loading and stale readings are distinguished; an unavailable organization's Retry row is not an empty organization. Import failures have their own error rows and preserve the old source.

## Remote engines

Organizations that run on a remote standalone (headless) engine are listed below this computer's own, each engine's under a heading with the remote glyph, the engine's name and, when it is not connected, a state word (connecting, offline, sign-in needed, can't connect, paused). Each remote row carries the same glyph before its name and a tooltip naming the engine and its address; it opens like any organization. While its engine is not connected a row stays in the list without counts or a spinner: those would be the last known numbers, not current ones.

Add a remote engine... under the list opens a dialog with Address (for example `http://100.x.y.z:7430`), Token and an optional Name. Paste the engine's startup token or a client token: Orgtree makes its own named client token on that engine ("Orgtree desktop (computer name)") and keeps only that. Everything is checked before anything is saved, and a refusal is shown under the fields, which keep what was typed. `https` addresses are accepted anywhere; plain `http` only for this computer, a private network or Tailscale. A watch-only (viewer) token is refused.

Click an engine's heading, or use its right-click menu, for Connection details, Retry now, Disconnect or Connect, and Remove. Connection details shows the name (editable), address, state, how the connection travels, the remote engine's version (with a note when it differs from this app's), the token this computer signed in with and the last error, and offers Replace token. While Streamer mode hides IP addresses, the address and this computer's name (in "Signed in as") are blurred there. Removing a connection takes its organizations out of this list and revokes this computer's token on that engine when it can be reached; nothing on that engine is deleted.

In a remote organization's window, what belongs to the engine's computer says so instead of acting on this one. Folder entries (scratch, team, templates, charters) open nothing here and answer "This folder is on (engine name), not on this computer."; a file path in a transcript can be copied but not opened or revealed; the folder picker lists the engine's disk under the title "choose a folder on (engine name)"; a provider's Sign in button is replaced by a sentence that says to sign in on the engine itself. App settings there shows the engine's settings, with a note at the top, and marks the tabs and groups that stay this app's own with "this computer". Questions and other notices of a remote organization appear among this computer's notifications and in the tray, titled with the organization and the engine's name. A remote organization whose name is taken on this computer is listed with the engine's tag after its name; references its agents write still open in its window.

No agent tool adds or changes a remote engine: connections belong to the user's desktop.

Creating from a homepage reuses that window for the creation form. Creating from an organization opens a separate creation window. An eligible first installation shows onboarding here before the ordinary homepage content.

## See also

- [orgtree-create-organization](../create-organization/SKILL.md)
- [orgtree-onboarding](../onboarding/SKILL.md)
