---
name: orgtree-tool-present
description: Present Markdown documents and captured HTML mockups as user-readable cards and update them in place.
---

Up: [orgtree-user](../SKILL.md)

# orgtree_present

Use for anything the user is meant to read: report, plan, proposal, write-up, summary or `.md` document. It creates a reader/gallery card associated with your seat. For a file wanted as a file, such as an installer/log/export/image/archive, use [orgtree_send_file](../tool-send-file/SKILL.md).

Required tool group: `user`, through the ancestor chain. Presenting also requires a user audience; top-level agents already have access. Without it, give the path/context to your superior to present or request an [audience](../../mail/tool-audience/SKILL.md). A tool grant alone is insufficient.

## Parameters and limits

| Field | Meaning |
| --- | --- |
| `title` | Required nonblank title. Trimmed, retained up to 120 characters. |
| `body` | Markdown text, at most 64 KiB of UTF-8 bytes. Use exactly one of body or path. |
| `path` | Existing `.md`/`.markdown`, or `.html`/`.htm`, instead of body. Relative paths start at your scratch folder; absolute paths still require authority. |
| `replaces` | Optional existing presentation ID belonging to you in this org. Updates that card in place instead of creating another. Empty value behaves as omitted. |

Minimal call:

```json
{"title":"Review summary","body":"The proposed change resolves the reported issue. The remaining question is the retention period."}
```

For a Markdown file, the engine reads UTF-8 text and removes a leading UTF-8 BOM. The same 64 KiB text limit applies. An oversized document must be shortened or split across cards; it is not a reason to substitute a download card. Other file types are refused by present's path form.

## Snapshot and replacement

The stored body is a snapshot. Editing the original file does not update the card. Preserve the returned document ID and use it as replaces when revising that document. Replacement updates title/body/format/time, recaptures any HTML resources, and clears dismissal. You cannot replace another agent's presentation by guessing its ID.

Paths are canonicalized and checked inside your scratch or effectively held folders, with organization/ancestor scope clamps and your held organization/shared/team workspaces. Symlinks do not grant access outside those roots. An inaccessible/missing file refuses instead of presenting whatever a path happened to name.

## HTML capture and preview

The HTML entry is limited to 4 MiB. Capture collects supported local HTML/CSS dependency references under its source directory, including nested CSS resources, with a 25 MiB total resource bound and 4,096-file cap. Absolute/escaping/protected/missing local asset paths refuse. A resource in another granted folder still cannot escape the mockup root. Dynamically discovered assets are not guaranteed captured.

The preview embeds captured resources in an isolated sandbox with scripts allowed, but no network connections, form submission or app access. Prefer inline scripts/styles and local resources; a remote CDN/API dependency is not a working offline preview. The captured preview is separately size-bounded to 25 MiB. The download is HTML for a single file, or a ZIP with original relative layout for an asset bundle. Later source edits do not change either stored capture.

## What reaches the user

The successful result returns a presentation ID and card. Canvas/desk compact surfaces show recent presentations; the wider gallery opens the collection. Markdown uses the reader. Direct HTML chips open the mockup in a new tab; gallery readers have an explicit mockup link. Available menus include title/reference copying and format-specific downloads. Closing the reader differs from dismissing a card.

A successful transcript call has its ordinary timed, expandable tool row followed by the untimed presentation card; failures remain tool rows. User viewed/new/updated indicators are separate from tool success. A presented document is not proof of reading, agreement, deployment or functional verification of the mockup.

Common refusals include missing title, giving both/neither body and path, exceeding the Markdown/HTML/capture bounds, non-UTF-8 Markdown, unsupported extension, out-of-scope path, missing assets, invalid replaces ID and missing user audience. Correct the named problem before retrying; when updating, reuse replaces rather than creating duplicate cards.
