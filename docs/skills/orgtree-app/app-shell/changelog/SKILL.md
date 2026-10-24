---
name: orgtree-changelog
description: Read the Changelog panel: one row per release with its date, time and notes, its opening after an update, and the same notes for agents.
---

Up: [orgtree-app-shell](../SKILL.md)

# Changelog

The Changelog lists every published Orgtree release, newest first, with what changed in it. Open it from the Orgtree application menu with **Changelog…**, directly below **Usage history…** ([orgtree-org-header-and-menu](../org-header-and-menu/SKILL.md)). It has the Presentations panel's layout: versions on the left, the selected version's notes on the right. In an organization window it pins and pops out like the other panels; at home it is a centred panel.

- **Rows.** Each row is one version: its number and its release date and time, in local time. The newest is at the top, and it is the one open every time the panel opens: from the menu, on its own after an update, or as a pinned panel restored at startup. Select another row to read it; Alt+Up and Alt+Down step between rows.
- **Release date and time.** The time of the commit the release's tag names: the commit its published build was made from. GitHub publishes a release a little later (4.4.4: tagged 02:58 UTC, published 05:23 UTC).
- **Notes.** A release's notes are its GitHub release description, built into the app, so the panel works offline and needs no network.
- **Unpublished builds.** A build that is not a published release, such as a local alpha, adds one row on top for itself, marked **Unpublished build** and dated by its own build commit. It shows the draft notes of the release it leads to when the build has them, and otherwise says they are written when that release comes out. A published build never shows such a row.

## Opening after an update

The first time Orgtree starts after an update, the Changelog opens on its own in the first window, on the new version. A fresh install never opens it, and neither does a second start of the same version or a downgrade. If no window opens during that first start (Orgtree started in the background), the first window of a later start shows it instead.

**Open changelog after updates** (App settings › Display › Startup, on by default; see [orgtree-app-display-input-and-startup](../../app-settings/app-display-input-and-startup/SKILL.md)) turns the automatic opening off. The menu entry still opens it. The panel's header has a link to that setting, **Open after updates: On** or **Off**, which opens App settings at it.

## For agents

There is no tool for the panel itself: agents have no window. The same notes are in this glossary, exported from the build the agent runs on, in the `releases` folder beside this page:

- `releases/index.md` lists every row, newest first: version, release time in UTC, and its notes file. An unpublished build's row names the draft it shows.
- `releases/<version>.md` holds each version's notes, exactly as the panel shows them.

Read them to answer what changed in a version or since one, or to quote a release's notes. The automatic opening is the user's display preference: agents explain it and do not change it.
