---
name: orgtree-app-settings
description: Find the app-wide Runtime, Display, Default org settings, Developer, Shortcuts and About references.
---

Up: [orgtree-app](../SKILL.md)

# App settings

Every setting name, description/help text, section heading and settings-screen button label uses sentence case. Preserve proper nouns, product names, acronyms and literal identifiers such as org.md.
Open the Orgtree menu and choose App settings. These controls apply across organizations on this machine; defaults for new organizations seed later creations. Open the individual leaf for its save behavior, defaults and application timing. Agents explain and suggest changes; the user operates the controls.

Display > Text includes the opt-in **Wrap object mentions** switch (default
off); see [appearance](app-display-appearance/SKILL.md#object-mentions).

## Pin, pop out and open at a section

Inside an organization window App settings has the same ↗ pop-out and pin buttons as Org settings, Usage and the other modals: pin it to the window (drag, resize, it stays while the canvas pans), or open it in a window of its own. Placement is kept per organization, so each organization remembers its own pinned or popped-out App settings and one organization's does not follow the user home or into another. At home, with no organization to pin it into, it is an ordinary centred modal (as Usage is there). A link that points at one setting, such as the turn-slot banner's **Open settings** (the Runtime row *Most agent turns running at once*), opens the panel, or raises it if it is pinned behind another window or popped out, and never closes it; the panel switches to the tab, scrolls the row into view, focuses its control and highlights it for about two seconds, in the window where it lives.

## Search

The box at the top of App settings searches every tab of this window. Typing filters to the settings whose name, help text, section or tab matches all of the typed words, in any order and case; the results are grouped under their tab and section, with the matches marked. Click a result, or choose one with Up/Down and press Enter: the box clears and the window opens that tab with the row scrolled into view, its control focused and the row highlighted for about two seconds. A tab whose name matches but that holds no settings (such as Harnesses) is offered as a result that opens it. Ctrl+F (⌘F on macOS) in the window focuses the box; Esc clears it, and Esc on an empty box closes an unpinned window as before. Nothing matching reads "No settings match" with the query. A search also loads the Mail hub section so its settings can be found. Org settings and Agent settings have the same box.

## Settings

For **New hires go** (End / Start / Centre), use
[Display > Desk](app-display-desk-and-chart/SKILL.md#new-hires-go). This is an
app-wide user preference for ordinary new agents and projects.

- [orgtree-app-runtime-desktop](app-runtime-desktop/SKILL.md): Runtime > desktop behavior: run on boot (where agents and the engine run), exit on close, automatic updates, Run as admin and Run this session as admin.
- [orgtree-app-notifications](app-notifications/SKILL.md): Runtime > Notifications: the master switch and each notification kind.
- [orgtree-app-quick-staff](app-quick-staff/SKILL.md): Runtime > Quick staff behavior: request staffing vs staff immediately.
- [orgtree-app-turn-limits](app-turn-limits/SKILL.md): Runtime > Turn time limits: total and silence limits.
- [orgtree-app-live-feed](app-live-feed/SKILL.md): Runtime > Live feed: the local engine event feed, its port, access tokens and the websocket-dog recipe.
- [orgtree-app-concurrency-and-checkups](app-concurrency-and-checkups/SKILL.md): Runtime > Turns: concurrent turns, working checkups, MCP wait, docket reminders, process warming.
- [orgtree-app-credit-bubbling](app-credit-bubbling/SKILL.md): Runtime > Credit cost bubbling: the user's two app-wide switches (agents always bubble).
- [orgtree-app-charters-and-templates](app-charters-and-templates/SKILL.md): Runtime > Charter documents and Organization templates: template folders, populating documents, restoring default templates.
- [orgtree-app-display-appearance](app-display-appearance/SKILL.md): Display > Appearance and Canvas background: theme, custom color, contrast color, agent colors, canvas background and intensity.
- [orgtree-app-display-desk-and-chart](app-display-desk-and-chart/SKILL.md): Display > Desk: chart layout, desk text size, piles, retired agents, card shortcuts, pinned-panel behavior.
- [orgtree-app-display-input-and-startup](app-display-input-and-startup/SKILL.md): Display > quick chat position, Enter key, and Startup behavior.
- [orgtree-app-default-org-settings](app-default-org-settings/SKILL.md): Default org settings: values new organizations start with (also the standalone form).
- [orgtree-app-developer](app-developer/SKILL.md): Developer: the engine debug view and verbose engine logging, and the logs folder.
- [orgtree-app-keyboard-shortcuts](app-keyboard-shortcuts/SKILL.md): Keyboard shortcuts: the read-only list of bindings.
- [orgtree-app-about](app-about/SKILL.md): About: version, engine commit, update check.

Provider, harness, account and hub controls have their own sections: [providers](../providers/SKILL.md) and [mail hub](../mailhub/SKILL.md). Existing organization values are under [org settings](../org-settings/SKILL.md); one agent’s configuration is under [agent settings](../agent-settings/SKILL.md).
