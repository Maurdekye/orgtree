---
name: orgtree-org-header-and-menu
description: Locate every organization header action and application menu destination.
---

Up: [orgtree-app-shell](../SKILL.md)

# Header and application menu

The header identifies the organization and switches between Canvas and [Attention](../attention-view/SKILL.md). Quick chat can occupy its center. The [kill switch](../kill-switch/SKILL.md) sits beside the organization actions.

If the organization has a logo set in Organization settings, a small square
version appears immediately left of its name, at the height of the header
text. It updates when the logo changes; no logo leaves no icon or reserved
space. Organization settings shows the same logo when opened separately.

| Control | Destination |
|---|---|
| Inbox bell | Questions and urgent mail in the organization's inbox |
| Work | Docket toolbar and work items |
| Presentations | Presented documents; its badge counts documents from currently hired agents |
| Organization settings | This organization's configuration |
| Update notice | Available update information or action |
| Refresh | Reload this renderer window |
| Minimize, maximize/restore, close | Native controls for this window |

The Orgtree application menu contains New window, Open organization, Create new organization, App settings, Usage, Usage history, and Changelog. Changelog, directly below Usage history, opens every published release's notes, newest first ([orgtree-changelog](../changelog/SKILL.md)). Open organization is a submenu with filtering for larger lists and an already-open indicator; selecting an open organization focuses its window. Arrow keys navigate the menu and Escape closes it or its submenu.

## Attract mode

**Attract mode** (switched in App settings › Streaming, see [orgtree-app-display-appearance](../../app-settings/app-display-appearance/SKILL.md)): when it is on, an organization window left with no input for more than its start-after time (five minutes unless you change it, see Streaming) runs itself. It moves at random between agents with new transcript activity, the whole organization, new unread mail to you, new or updated presentations (scrolled through), and updated tickets, about 8 to 15 seconds each. When it opens a ticket that changed, it opens it at the change: it compares the ticket's text with what that window last showed of it, expands the section holding the first difference, shows the ticket header, glides to that exact spot in a couple of seconds (it does not read down through the ticket) without marking the text, never holds the docket longer than 15 seconds, comes to the docket at most every fourth step and spends at most about 15 percent of any five minutes there (a ticket you were flagged on gets one docket visit per five minutes), so most of its time goes to the org and to agents and their desks, and puts the sections back as they were when it moves on. A window that has not shown the ticket yet (a new window, or after a restart) has nothing to compare, so an evidence row added since your last input opens the evidence notes section, and anything else shows the top of the ticket. Anything it shows counts as read. It never focuses a desk that is pinned or popped out, and when there is nothing new it only fits the whole organization. Even when something is new, it keeps coming back to fitting the whole organization, and how often depends on how much is new: with one thing new it goes back and forth between that and the whole organization, with a few new things it fits the organization every third step, and with dozens it does so only every tenth to fifteenth step (never more than fifteen in a row). While it runs, attract mode keeps a small trace of its own steps (kinds and timings only) in `diagnostics/ui-attract.jsonl` in the data folder, separate from the freeze records.
 Anything that needs your attention and appears while it is running is shown at once, without waiting for the current step: an open question, a ticket someone flagged for you, urgent mail, or an @user mention. Several arrivals are shown in the order they came, one per step, before the ordinary rotation; each is shown once per arrival. If that agent's desk is visible anywhere (pinned, in the Attention view, in its own window or in another panel), attract mode skips that agent entirely: it does not focus, pan to or change anything for it. Interacting with the canvas stops it (a click or press, a drag or pan, the wheel or a zoom, or a key while the canvas has focus), and so does really using a panel attract mode opened: a click or touch in it, the wheel over it, or a typed key (not a lone Alt, Ctrl, Shift or Meta, and not the Tab of an Alt+Tab) while focus is inside it. Either way it leaves the screen as it is, and the panel you touched stays open and is yours; it comes back only after the next quiet period. Hovering, switching windows and tabbing back in do not stop it. When a run starts it first closes every docket open in the window (a docket in its own popped-out window is left alone). Anything in a desk, menu or settings does not stop it, though any input still restarts the quiet time before it can begin.

App settings affect the application; Organization settings affect the selected organization. Usage is reached through the application menu. For keyboard bindings see [App keyboard shortcuts](../../app-settings/app-keyboard-shortcuts/SKILL.md).

## Streamer mode

The App menu has no Modes section: **Streamer mode** and **Attract mode** are switched only in App settings ›
Streaming, which also has the **Attract mode starts after** field.
A visible Streamer mode indicator remains on screen while protection is enabled,
including in popped-out windows. The choice persists and synchronizes across windows.

Streamer mode masks screen text matching known account/settings identities and
conservative patterns for secrets, email addresses, local paths (including usernames),
keys, IP addresses, account names, hub addresses, phone numbers and URL tokens.
Uncertain long identifiers and URLs are hidden conservatively. Editors are visually
masked while remaining editable. Canvas, desks, displayed transcripts, panels and
Markdown presentations use the same text boundary.

HTML apps/presentations, images, videos and embedded-document previews have
a **Hidden in Streamer mode** cover, drawn in place of that surface only; the canvas,
its connection lines and icons stay visible, and menus and dialogs stay above any cover.
The window itself is never blanked: values are masked one by one, and the indicator's
**Turn off** button is always available. The underlying content continues running.
Dismiss the cover with its close control to reveal only that surface; this choice
lasts until the surface closes or Streamer mode is switched off and on again.
Text masking has no per-value reveal. Native notifications and window titles use
generic text; existing notices close on enable. App-owned native menu/dialog text
is conservatively masked, while its actions remain available.

**On screen only:** original agent inputs, stored transcripts, editor/submission
values, links and copied/clipboard data are unchanged. Copy can therefore contain
the original sensitive value. **Native OS file/open/save dialogs and browser file
inputs are explicitly excluded** and remain usable; their filenames and paths can
be visible. Open native select, date and color popups are also excluded; their
closed-state values remain masked and controls stay usable. Inputs have browser
autocomplete/autofill turned off while the mode is active, with previous attributes
restored on disable. Content deliberately revealed by dismissing an opaque cover is visible.
If identity loading or the browser's masking support is unavailable, content stays
covered; the visible indicator offers Turn off. Pattern matching is conservative,
but cannot identify an arbitrary unlabelled short secret as secret text.

## See also

- [orgtree-attention-view](../attention-view/SKILL.md)
- [orgtree-inbox-screens](../../desk/inbox-screens/SKILL.md)
- [orgtree-docket-screens](../../desk/docket-screens/SKILL.md)

## Transcript mentions

A glowing @ button appears immediately left of the STOP ALL latch in Canvas and Attention while the organization has unobserved transcript mentions. Its corner badge counts current transcript mention markers. Click to open the newest mention in its agent desk, select Chat and center/highlight the mentioning passage; observing it reduces the count, and repeated clicks visit the remaining mentions newest first. The button disappears when none remain. Mail mentions keep the Inbox cue and do not add to this count.

With the Mentions notification category enabled, standalone @user mentions in transcript prose, mail, presentations and docket text can also raise native notifications. Their clicks open the exact related conversation, mail, document or item. Code spans and code blocks do not trigger mentions. Presentation/item mention banners are one-time alerts rather than persistent taskbar-badge requests. Use plain @user when deliberately requesting visibility; something needing an answer still belongs in a message or question. Notification settings are documented in [App notifications](../../app-settings/app-notifications/SKILL.md).

## Apps

The Apps header button beside Presentations lists app definitions and saved panels.
See [orgtree-apps](../apps/SKILL.md) for New, reopen, state menus and placements.
