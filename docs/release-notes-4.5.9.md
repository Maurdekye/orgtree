# Orgtree 4.5.9

Orgtree 4.5.9 opens Hubchat's Orgtree mention chips in Orgtree, adds a search box to the App, Org and Agent settings, and tidies a few settings screens. It still bundles Mail hub 2.4.0. Use it with Hubchat 1.3.3, which draws the chips.

## Hubchat mentions open in Orgtree

- **`orgtree://` links.** Orgtree now accepts `orgtree://` links, the mirror of the `hubchat://` links it already opens for Hubchat. In Hubchat 1.3.3 a mention chip for an org that runs on this PC opens its target in Orgtree: a docket item, a presented document, an app, a panel, an agent or project node, or a mail. A menu entry in Hubchat opens just the org.
- **Registration.** The installed app registers `orgtree://` for your Windows user the first time it starts, the way Hubchat registers `hubchat://`, and only when the link doesn't already point at it. Development and test builds never register it.
- **Strict links.** Orgtree accepts only the exact link shape for each kind (lowercase letters, digits, `@`, `-` and `/`, at most 400 characters) and refuses anything else, so a link can only open something; it never carries text or commands.

## Settings search

- **A search box in App, Org and Agent settings.** It finds a setting by its label, its help text, its section or its tab, across every tab, and lists the hits grouped by tab with the matching words highlighted. Click a hit, or pick it with the arrow keys and Enter, and the window switches to that tab and scrolls to the setting.
- **Keys:** Ctrl+F (Cmd+F on macOS) focuses the search box and Esc clears it. **Keyboard shortcuts** lists them.

## Settings screens

- **The "this also raises the agents between you and…" warning** in an agent's settings now shows only when a pending change would actually raise those agents. The full warning sits on the **Scope** and **Tools** tabs; on other tabs a short note by **Save** says the save raises them.
- **API-key accounts** (such as a metered Anthropic API key) no longer show "email unavailable", a **Sign in** button or a sign-in status in the usage screens, account choosers, the Accounts registry and agent settings. A key has no email or sign-in, so the line shows just the provider and account name.

## Agents

- **Effort changes on Claude agents.** The always-loaded rules and the `orgtree_retool`, `orgtree_switch_model` and `orgtree_interrupt` descriptions now say that an effort-only change on an eligible Claude agent applies at its next model call, mid-turn, with no interrupt or restart. Agents no longer restart a Claude seat just to change its effort. Existing Claude agents receive the changed text once on their next turn.

## Untested

- A chip click was tested end to end by the user on the 4.5.9 test build with Hubchat 1.3.3's test build. The link parser and registration were tested by automated tests; other Windows set-ups (several Orgtree installs, a non-default profile) were not.
- Settings search, the raise warning and the API-key account lines were tested by automated renderer tests and by the user on the test build, not on every settings tab of a large live organization.
- macOS and Linux don't register `orgtree://` in this release.

## Notes

- There are no database changes in this release.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
