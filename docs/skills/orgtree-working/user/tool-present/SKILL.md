---
name: orgtree-tool-present
description: Present Markdown documents and captured HTML presentations as user-readable cards and update them in place.
---

Up: [orgtree-user](../SKILL.md)

# orgtree_present

Use for anything the user is meant to read: report, plan, proposal, write-up, summary or `.md` document. It creates a reader/gallery card associated with your seat. For a file wanted as a file, such as an installer/log/export/image/archive, use [orgtree_send_file](../tool-send-file/SKILL.md).

Required tool group: `user`, through the ancestor chain. With `project=<P>`, an agent inside P may present to that project without a user audience; this includes agents inside nested projects. An agent above P still needs a user audience. Presenting with no project, or outside a project you belong to, requires a user audience; top-level agents already have access. Project reach remains required, so a user audience alone does not grant access to an unrelated project. Without the required authority, give the path/context to your superior to present or request an [audience](../../mail/tool-audience/SKILL.md). A tool grant alone is insufficient.

## Parameters and limits

| Field | Meaning |
| --- | --- |
| `title` | Required nonblank title. Trimmed, retained up to 120 characters. |
| `body` | Markdown text, at most 64 KiB of UTF-8 bytes. Use exactly one of body or path. |
| `path` | Existing `.md`/`.markdown`, or `.html`/`.htm`, instead of body. Relative paths start at your scratch folder; absolute paths still require authority. |
| `replaces` | Optional existing presentation id (its slug; the generic id an older card had still works) in the same destination bucket: your own agent's gallery, or the selected project's gallery. Updates that card in place instead of creating another. Empty value behaves as omitted. |
| `slug` | Optional, new presentations only: the id to give the card, a short English slug such as `weekly-status`. Pass one whenever the title isn't in English; the title itself can be in any language (user 2026-10-27). It is cleaned the way a title becomes a slug (below) and gets `-2`, `-3`... when the organization already has it; the result names the id it got. Refused together with `replaces` (a slug stays fixed once made), and refused when it has no ASCII letter or digit, since nothing would be left. Empty value behaves as omitted. |
| `project` | Optional live project node name. The card goes under that project instead of beside your seat; you must be above or below it ([orgtree-projects](../../team/projects/SKILL.md)). Members, including nested descendants, need no user audience for this project; agents above it still need one. |

Minimal call:

```json
{"title":"Review summary","body":"The proposed change resolves the reported issue. The remaining question is the retention period."}
```

For a Markdown file, the engine reads UTF-8 text and removes a leading UTF-8 BOM. The same 64 KiB text limit applies. An oversized document must be shortened or split across cards; it is not a reason to substitute a download card. Other file types are refused by present's path form.

## Snapshot and replacement

The stored body is a snapshot. Editing the original file does not update the card. Preserve the returned presentation id and use it as replaces when revising that document. Replacement updates title/body/format/time, recaptures any HTML resources, and clears dismissal. In your own gallery, the ID must belong to your agent. A project is a shared destination: any agent currently authorized to present into that project can replace an existing presentation in that project's bucket, including one originally presented by another agent. The project remains the displayed owner and the **presented by** attribution switches to the replacing agent. An ID from a different agent/project bucket is refused.

Paths are canonicalized and checked inside your scratch or effectively held folders, with organization/ancestor scope clamps and your held organization/shared/team workspaces. Symlinks do not grant access outside those roots. An inaccessible/missing file refuses instead of presenting whatever a path happened to name.

Folder authority and membership in an ancestor project resolve through the complete chain, including more than 1,024 nested projects. Root scope restrictions still apply; an ancestry cycle or missing root refuses folder authority. Reaching a project below you still needs the ordinary user audience to present there; deep membership adds no broader audience or file grant.

## Presentation ids

A presentation's id is a readable slug made from its title when it is first presented (user 2026-10-27): lowercase ASCII words joined by `-`, at most 48 characters, then `-2`, `-3`... when the organization already has that slug, and `presentation` for a title with no ASCII letter or digit. It is unique in the organization and never changes, even when `replaces` gives the card a new title. Pass `slug` to choose the id instead, in English whenever the title isn't: a title in Hebrew, for example, keeps its own language but would otherwise get `presentation`, `presentation-2`... (user 2026-10-27: "use an english name for the slug, the actual name can be whatever it needs to be in any language"). A requested slug gets the same cleanup and suffixes. Presentations made before 4.5.0 got slugs the same way on upgrade. The generic id they had before (`d` and 12 hex digits) keeps working wherever an id is accepted, so older mail, mentions and `replaces` calls still find them.

Mention a presentation as `@doc:<org>/<slug>`, never by its bare title: the result names that reference, and the card and `read_presentation` entries carry it as `ref`. The link shows the presentation's current title.

## HTML capture and preview

The HTML entry is limited to 4 MiB. Capture collects supported local HTML/CSS dependency references under its source directory, including nested CSS resources, with a 25 MiB total resource bound and 4,096-file cap. Absolute/escaping/protected/missing local asset paths refuse. A resource in another granted folder still cannot escape the HTML file's source directory. Dynamically discovered assets are not guaranteed captured.

An HTML presentation must be self-contained for offline use: inline its resources or keep
every referenced local asset under the source directory. Local references are
resolved relative to the HTML or CSS file containing them; package imports are
not looked up in an installed dependency tree. For example, CSS containing
`@import 'katex/dist/katex.min.css'` needs that file beneath the referring CSS
file's directory, or must be bundled/inlined before presenting.

If a local stylesheet, CSS import/URL, image, script or other captured asset is
missing or unreadable, present refuses instead of skipping it. The error names
the asset reference as written, the path it resolved to, and the HTML or CSS file
that referenced it. For a nested CSS dependency, that last file is the CSS file,
not just the entry HTML. Correct the reference or supply the asset, then retry.

The preview embeds captured resources in an isolated sandbox with scripts allowed, but no network connections (WebRTC included), form submission or app access. Prefer inline scripts/styles and local resources; a remote CDN/API dependency is not a working offline preview. The captured preview is separately size-bounded to 25 MiB. The download is HTML for a single file, or a ZIP with original relative layout for an asset bundle. Later source edits do not change either stored capture.

## Theme colors

An HTML presentation receives Orgtree's current colors as CSS custom properties (user 2026-10-27: "feed the current theme coloring into html presentations and apps", for "both the main visual theme color and the contrast theme colors"). Use them when the page should look at home in Orgtree, as reports, dashboards, tables and notes usually should. Keep your own colors where the look is the point: a mockup of another product, a brand, print, or colors that carry meaning in a chart. Give every use a fallback, which a downloaded copy uses: `var(--orgtree-bg, #ffffff)`.

| Variable | Color |
| --- | --- |
| `--orgtree-accent` | The visual theme's accent: links, highlights, primary buttons |
| `--orgtree-accent-hover` | The accent on hover |
| `--orgtree-accent-soft` | A translucent accent tint: selected rows, badges |
| `--orgtree-accent-text` | Text on an accent fill |
| `--orgtree-bg` | The contrast theme's page background |
| `--orgtree-sidebar` | Side panels |
| `--orgtree-card` | Cards and widgets |
| `--orgtree-hover` | Hover and raised surfaces |
| `--orgtree-input` | Input fields |
| `--orgtree-text` | Body text |
| `--orgtree-text-strong` | Headings and emphasis |
| `--orgtree-text-dim` | Secondary text |
| `--orgtree-border` | Borders |
| `--orgtree-border-soft` | Subtle dividers |
| `--orgtree-success`, `--orgtree-danger`, `--orgtree-warning` | Status colors |
| `--orgtree-color-scheme` | `dark` or `light` (the Light and Solarized Light contrast colors are light) |

Each color is concrete, `#rrggbb` or `rgba(r, g, b, a)`, and follows the user's current choices: a custom accent, and the deeper accent and status partners Orgtree uses on the light contrast colors. A minimal themed page:

```css
:root { color-scheme: var(--orgtree-color-scheme, light); }
body { background: var(--orgtree-bg, #ffffff); color: var(--orgtree-text, #1f2328); }
a { color: var(--orgtree-accent, #b5532f); }
.card { background: var(--orgtree-card, #f6f7f9); border: 1px solid var(--orgtree-border, #d0d7de); }
```

The variables sit in one zero-specificity rule ahead of the page's own CSS, so the page's own values and `:root` rules always win, and nothing else changes on a page that doesn't use them. They work in the reader and in **Open in a new window**. When the user changes the visual theme or contrast color, an open presentation restyles in place without reloading. A script that paints with them, on a canvas for example, reads them when it draws (`getComputedStyle(document.documentElement).getPropertyValue('--orgtree-accent')`); no event announces a switch. App panels get the same variables and a script API ([orgtree-tool-apps](../../team/tool-apps/SKILL.md#theme-colors)).

## What reaches the user

The successful result returns the presentation's id and mention reference, and a card. Canvas/desk compact surfaces show recent presentations; the wider gallery opens the collection. Markdown uses the reader. HTML presentations carry an **HTML** tag (`</> HTML`, or `</>` on compact chips). Direct HTML chips open the presentation in its own window. Gallery readers show the selected presentation inline in the same sandbox, with **Fit width**/**100%** and an **Open in a new window** link; a captured preview over 4 MiB opens only in its window. The user can interact with an HTML presentation, but it cannot send anything back to you: presentations are one-way. Available menus include title/reference copying and format-specific downloads. Closing the reader differs from dismissing a card.

A successful transcript call has its ordinary timed, expandable tool row followed by the untimed presentation card; failures remain tool rows. User viewed/new/updated indicators are separate from tool success. A presented document is not proof of reading, agreement, deployment or functional verification of an HTML presentation.

Common refusals include missing title, giving both/neither body and path, exceeding the Markdown/HTML/capture bounds, non-UTF-8 Markdown, unsupported extension, out-of-scope path, missing assets, invalid replaces ID, a `slug` given with `replaces` or with no ASCII letter or digit, and missing user audience. Correct the named problem before retrying; when updating, reuse replaces rather than creating duplicate cards.

## See also

- [orgtree-reaching-the-user](../reaching-the-user/SKILL.md)
