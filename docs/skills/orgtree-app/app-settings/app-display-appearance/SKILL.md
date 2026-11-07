---
name: orgtree-app-display-appearance
description: Explain visual accents, custom colors, contrast, agent colors and canvas background settings.
---

Up: [orgtree-app-settings](../SKILL.md)

# Appearance

## Streaming category

App settings > **Streaming** (it was the Streamer mode category; the Modes section is no longer in Display) holds **Streamer mode** and **Attract mode**, the only place to switch them (the App menu has no Modes group); the settings are app-wide and every open window follows at once. In order: the **Streamer mode** switch; **Turn on automatically while OBS is running** (on by default, desktop app only), which lets Orgtree switch Streamer mode on itself while OBS, Streamlabs, XSplit or another streaming app is running, the way Discord's Streamer Mode does, and off again when the last one closes. It only switches off what it switched on: a Streamer mode you turned on yourself stays on. If you turn Streamer mode off by hand while a streaming app is running, it stays off until that app has closed and started again. The indicator then says "turned on because OBS is running".

Then **What Streamer mode hides**, one switch per type, each with a one-line description and an example: **Local file paths** (off by default), **IP addresses**, **Email addresses**, **Secrets and keys**, **Phone numbers**, **Token URLs**, **External addresses** (`@net:` and `@org:` addresses, org-mailbox senders) and **Other orgs** (the names of other organizations on this installation; this org is always visible), all on by default. A ninth switch, **Cover HTML apps, HTML presentations and video**, controls the "Hidden in Streamer mode" cover over content that cannot be searched; images are never hidden. Changes apply at once in every window.

Free-form content (messages, transcripts, tool output, mail, docket text, presentations) is searched for the enabled types and only the matching part is blurred. Row headers, chips and markers in a transcript (the title, sender, request id, status, date) are structured and never blurred; fixed fields that always hold one type, such as the account email in the usage panel or a folder path field, are blurred whole while their type is on and visible while it is off. Agent, project, account and model names, times, commit ids and branch names are never blurred. Copying and links still use the original values. Turning every type off is allowed: Streamer mode stays on and only the cover (if on) applies. While Streamer mode is on, its indicator (with **Turn off**) sits in the footer strip just before the version label, so it never covers a control; a window without a footer reserves a thin strip along its bottom edge.

While Streamer mode is on, nothing is shown partway through being written, because half of a key cannot be recognised. A tool call whose input is still streaming (a bash command, a file write or edit, MCP arguments) shows its written description, or a neutral placeholder ("writing command…", "writing input…"), and its input appears, masked, only once complete. An agent's response and thinking appear one complete line at a time: the line being written stays hidden until its newline (or the end of the message), then shows whole with masking applied. With Streamer mode off, streaming is unchanged.

Last, the **Attract mode** group. Under the Attract mode switch, **Attract mode starts after** sets, in whole seconds, how long a window must have no input before attract mode begins. The default is 300 (five minutes), the minimum is 0 and there is no maximum; it applies at once with no restart, and a value that is not a whole number from 0 up is not saved. At 0 attract mode starts as soon as there is no input, and again right after each click, drag, wheel turn or canvas key press ends; turn the Attract mode switch off to stop it. Below it, **Refuse questions to the user while attract mode runs** (on by default) makes the engine refuse new questions agents ask you (`orgtree_ask`, credit and scope requests) while any window of the organization is running attract mode; the agent is told to message you on Hubchat instead. Mail to you and questions already open are not affected. What each mode does is in [orgtree-org-header-and-menu](../../app-shell/org-header-and-menu/SKILL.md).

## Object mentions

Display > Text > **Wrap object mentions** is off by default. Turn it on to let
long ticket, presentation, app and panel links continue inline across lines,
preferring spaces and dashes and breaking an unbroken name only when needed.
The icon, state flare, hover underline, navigation and context menu stay with
the link. Off restores the existing unbroken control. It applies immediately
across windows and persists engine-wide, independently of theme preferences.
The one exception is an agent's status line in the agents list (the canvas list
and the Attention drawer): it stays on a single line, clipped with an ellipsis,
with the full text in the row's tooltip, whatever this setting is.

The existing user settings tool has parity:
`orgtree_settings(scope:"runtime",action:"configure",settings:{wrap_object_mentions:true})`;
use false to turn it off, or get the runtime scope to read it. This is a user
tool, retaining its existing authority; an agent does not acquire settings
permission by suggesting the change.

Display > Appearance and Display > Canvas background control presentation across this desktop profile. Agents explain or suggest these controls; they do not change settings themselves. Changes apply immediately without restarting agents or rewriting their prompts. A theme or background choice is not a provider/account selection and does not alter work-state meaning. HTML presentations and app panels that use Orgtree's theme colors, the `--orgtree-*` variables listed in `orgtree-tool-present` (orgtree-working › user), follow the visual theme and contrast color too, as they change (user 2026-10-27).

| Control | Storage | Choices and initial behavior |
| --- | --- | --- |
| Visual theme | `np:visualTheme`, with provenance visualThemeExplicit | Claude Terracotta, Codex Teal, Antigravity Navy, Muse Eggshell, OpenRouter Lavender, LMS Gold, Custom. |
| Custom color | Same visualTheme field, encoded as custom plus a six-digit hex color | Visible only for Custom. The picker displays the selected hex value; its initial draft color is neutral #b6bdc8. Settled changes save after a short debounce or on blur. |
| Contrast color | `np:contrastTheme` | Charcoal default, Light, Solarized Light, Obsidian Black. Controls background/text brightness independently of the accent. |
| Organization theme color for agents | `np:agentColorSource` | Off/provider by default; On uses organization instead of provider colors for agent surfaces. |
| Background | `np:canvasBackground` (`ls:orgtree-canvas-background` in a plain browser), `theme` | Dot grid (`dots`, default), Square grid (`square-grid`), Triangle grid (`triangle-grid`), Hexagonal grid (`hex-grid`), Checkerboard (`checkerboard`), Square tiles (`square-tiles`), Triangle tiles (`triangle-tiles`), Hexagonal tiles (`hex-tiles`), None (`none`), Claude Waves (`ascii`; alias `claude-waves`). Applies immediately across open canvases. |
| intensity | Same `canvasBackground` object, `intensities[theme]` | Range 0–100% in 5% steps (`0..1`, step `0.05`), stored sparsely per theme and debounced (250 ms or on blur). Defaults: `dots` 100%, grids 55%, `checkerboard` 25%, gapped outlined tiles (`square-tiles`, `triangle-tiles`, `hex-tiles`) 35%, `none` 0%, `ascii` (Claude Waves) 65%. |

The native preference starts with Claude and visualThemeExplicit=false. The renderer treats a nonexplicit theme as automatic: the first installed supported CLI selects Claude, Codex, Antigravity or Muse appearance in that order, with Claude as first-paint/no-provider fallback. An explicit saved choice wins; older saved themes without a provenance flag are treated as explicit. Therefore no single preset is the guaranteed visible default on every machine. Provider detection here is installation-based, not proof of sign-in or inference availability.

The retired Orgtree Grey preset is no longer offered. Legacy visualTheme=orgtree with explicit true or a missing provenance flag becomes Custom #b6bdc8 (RGB182,189,200), explicit true. Legacy explicit=false was an unset placeholder, so it becomes Claude with explicit=false and still follows provider detection. Main preference reads and writes normalize it; browser-local stored choices migrate to Custom. Organization settings, templates, imports and agents have no separate visualTheme field. The old light-only partner #4c5565 is not the migrated custom RGB. Custom uses its existing generic palette derivation.

With a native bridge, preferences persist independently of the engine's port and broadcast to windows. In a plain browser, the appearance modules use their browser-local stores instead. Errors remain visible rather than being proof a change was saved. These stores are preferences, not organization policy.

When already revealed under Custom, Rainbow mode toggles accent cycling. A preset hides that row without clearing its saved state; returning to Custom restores it. The regular theme choice does not replace semantic status colors or provider identity badges.

Under Canvas background, grids, Checkerboard and gapped outlined tiles pan and zoom with the canvas like a floor, while the dot grid keeps its gentle parallax. Legacy unversioned `square-tiles` preferences migrate to `checkerboard` (`version: 2` marks explicit outlined `square-tiles` choices). Claude Waves (`ascii`) renders a WebGL2 flowing ASCII field in the current theme's colors with pointer wakes and floor-click ripples; it pauses when hidden, minimized or at 0% intensity (an unfocused but visible window keeps animating), bounds zoom-out work, and degrades and auto-recovers if external GPU/CPU load stalls frame delivery or WebGL context is lost.

Suggest contrast changes or a calmer canvas background/lower intensity for readability, and an accent/custom color or backdrop preset for visual preference. Suggest organization-colored agents when the user wants a consistent theme; provider colors preserve visual differentiation. Do not use a color or background change to diagnose provider limits, permissions or an agent's work status.
