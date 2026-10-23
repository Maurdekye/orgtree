---
name: orgtree-tool-files
description: List retained download cards delivered by yourself or a descendant.
---
Up: [orgtree-inspection](../SKILL.md)

# orgtree_files

List the local download cards recorded by orgtree_send_file, newest first.
This deferred tool requires the inspection group through the ancestor chain.
It reads your own files by default; node selects a descendant, including through
projects. Unrelated agents and project nodes refuse. Retired agents retain their
recorded deliveries, and renaming preserves attribution to the same agent.

| Parameter | Meaning |
| --- | --- |
| node | Optional agent name; omitted means yourself. |
| limit | Integer from 1 to 100; default 50. |
| before | The previous page's next_cursor, unchanged; omit for newest. |

Each file has delivery_id, name, bytes, at, note and its recorded snapshot path.
next_cursor is null at the end. Reading does not resend a file, change its note,
mark it read, or prove that the user downloaded it. Retained past deliveries
appear too; this is independent of transcript windows and current source files.
The snapshot may no longer exist if removed externally: listing its metadata
does not restore its bytes or grant additional file authority.

Reuse orgtree_send_file delivery_id for an uncertain retry; retries keep one
recorded delivery. orgtree_transfers lists hub attachment jobs and does not
cover these local file cards. The user's Files desk tab reads the same records.

## See also

- [orgtree-tool-read-transcript](../tool-read-transcript/SKILL.md)
- [orgtree-tool-read-scratch](../tool-read-scratch/SKILL.md)

For delivery limits and snapshots, see orgtree-tool-send-file (orgtree-working > user).
