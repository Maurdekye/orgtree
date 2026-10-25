---
name: orgtree-changelog
description: Read the Changelog panel: one row per published release with its date, time and notes, its opening after an update, and the same notes for agents.
---

Up: [orgtree-app-shell](../SKILL.md)

# Changelog

The Changelog lists every published Orgtree release, newest first, with what changed in it. Open it from the Orgtree application menu with **Changelog…**, directly below **Usage history…** ([orgtree-org-header-and-menu](../org-header-and-menu/SKILL.md)). It has the Presentations panel's layout: versions on the left, the selected version's notes on the right. In an organization window it pins and pops out like the other panels; at home it is a centred panel.

- **Rows.** Each row is one published release: its version and its release date and time, in local time. The newest is at the top, and it is the one open every time the panel opens: from the menu, on its own after an update, or as a pinned panel restored at startup. Select another row to read it; Alt+Up and Alt+Down step between rows.
- **Release date and time.** When GitHub published the release. A release is built before GitHub publishes it, so a release's own build, until a later build lists it, dates its own row by the commit it was built from (4.4.4's was made at 02:58 UTC; GitHub published it at 05:23 UTC).
- **Notes.** A release's notes are its GitHub release description, built into the app, so the panel works offline and needs no network.
- **Published releases only.** A build that is not a published release, such as a local alpha, has no row of its own: it lists the releases published before it was built.

## Opening after an update

The Changelog opens on its own, in the first window, the first time Orgtree starts after an update that brings a newer published release than this installation's Changelog has listed before, and it opens on that release. An update from one local alpha to the next with no newly published release between them opens nothing. A fresh install never opens it, and neither does a second start of the same version or a downgrade; going back up after a downgrade opens nothing either, since that release was listed before. The first update from 4.4.4 or earlier, which kept no record of what it listed, opens it. If no window opens during that first start (Orgtree started in the background), the first window of a later start shows it instead.

Two switches turn the automatic opening off and on again, and they are one setting: **Show this every time**, the checkbox in the Changelog's own header, and **Open changelog after updates** in App settings › Display › Startup (on by default; see [orgtree-app-display-input-and-startup](../../app-settings/app-display-input-and-startup/SKILL.md)). Either one changes the other. The menu entry opens the panel whatever they say.

## For agents

There is no tool for the panel or its checkbox: agents have no window. The same notes are in this glossary, exported from the build the agent runs on, in the `releases` folder beside this page:

- `releases/index.md` lists every row, newest first: version, when GitHub published it (UTC), and its notes file.
- `releases/<version>.md` holds each version's notes, exactly as the panel shows them.

Read them to answer what changed in a version or since one, or to quote a release's notes. The automatic opening is the user's display preference: agents explain it and do not change it.
