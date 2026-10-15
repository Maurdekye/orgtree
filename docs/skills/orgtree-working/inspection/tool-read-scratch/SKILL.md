---
name: orgtree-tool-read-scratch
description: List or read files inside your own or a descendant's working folder.
---

Up: [orgtree-inspection](../SKILL.md)

# orgtree_read_scratch

Use this to inspect a descendant's breadcrumbs, saved handoff or other scratch artifact without asking it to run. It browses the target's working folder; it does not expose every folder that the target holds as a grant.

## Parameters

| Parameter | Required/default | Meaning |
|---|---|---|
| `node` | Required | Your name or a descendant's name in this org; leading `@` accepted. |
| `path` | Omitted or empty | A path inside that working folder; omission lists the root. Use a relative file or subdirectory path. |

Requires effective `tools.orgtree.inspection`. Self is permitted; otherwise the target must be a strict descendant. Full chart visibility and top-level position do not permit reading peers' or superiors' folders. Existing non-deleted archived descendants can be read without an archive flag.

The engine resolves the target's stored working-folder location. Existing paths are canonicalized before containment checking, so an existing link leading outside that root is refused. Do not pass an outside absolute path or use traversal to request unrelated files.

## Result and limits

A directory returns sorted names: subdirectories end with `/`, and files show their byte size. It is one directory level, not a recursive listing; there is no cursor or entry-limit argument.

A file is read as text using lossy UTF-8 decoding and returned as plain tool text. The first 60,000 Unicode scalar characters are retained. If clipped, the result ends with `… (file continues; … bytes in all)`, using the original file's byte size. The cap counts characters, not bytes. There is no offset/chunk parameter, so this tool cannot page to the remainder. It does not convert binary documents or deliver a download card.

Common refusals include missing `node`, `no agent named … in this organization`, a non-descendant target, `that path is outside …'s folder`, and `… does not exist in …'s folder`. Read failures can use the missing-file wording; it is not proof that the file never existed. The operation does not create a missing scratch directory.

## Example

```json
{"node":"worker","path":"breadcrumbs.md"}
```

To discover files first, call `{"node":"worker"}`. For the saved conversation itself use [read transcript](../tool-read-transcript/SKILL.md).

## See also

- [orgtree-visibility](../visibility/SKILL.md)
- [orgtree-reading-reports](../reading-reports/SKILL.md)
