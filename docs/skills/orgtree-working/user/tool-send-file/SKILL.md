---
name: orgtree-tool-send-file
description: Deliver an immutable file download card with safe source paths and an identity for uncertain-response retries.
---

Up: [orgtree-user](../SKILL.md)

# orgtree_send_file

Use for files the user wants as files: installer, log, export, image or archive. Creating or naming a local file alone does not deliver it. Reports/plans and `.md` documents meant for reading go through [orgtree_present](../tool-present/SKILL.md), even when the request says send.

Required tool group: `user`, inherited through your ancestor chain. The current send-file implementation does not impose present's separate user-audience check; top-level and lower callers share the same file authority checks. Continue to honor session communication instructions and route readable documents through the superior/present path when required. Do not treat this distinction as permission to bypass them.

## Parameters and call

| Field | Meaning, default and limit |
| --- | --- |
| `path` | Required nonblank existing file path. Relative paths start in your scratch folder; absolute paths must still be readable under your effective authority. |
| `note` | Optional description, reduced to a 300-character gist. |
| `delivery_id` | Optional stable identity for this delivery; at most two hundred bytes. Reuse it after a lost/uncertain response for the same delivery; choose a new identity for a new version. Empty value behaves as absent. |

Minimal call:

```json
{"path":"out/export.csv"}
```

The file must be regular, nonempty and at most **256 MiB**. A directory refuses; create an archive first if that is the requested deliverable. Canonical containment checks use scratch/effectively held roots including organization/shared/team workspaces and ancestor clamps. A symlink to an ungranted location is not file authority.

## Delivery snapshot

The engine copies the source into a fresh delivery subdirectory of your scratch outbox, including when the source is already under outbox. Later source edits do not alter the delivered bytes. An outbox that canonicalizes outside scratch is refused. Success records a delivery and returns a download card in your chat; supported image extensions render a picture with filename/size/download access.

The successful tool row remains timed/expandable, followed by the untimed file card. It proves recorded delivery, not that the user downloaded, opened or accepted the file. The tool is local file-card delivery: use [mail attachments](../../mail/tool-message/SKILL.md) and [transfer IDs](../../mail/tool-transfers/SKILL.md) for hub file delivery instead.

## Idempotent retries

The engine allocates an identity before dispatch if one was not supplied. A preserved provider tool-use identity can yield a stable scoped delivery ID; failures include retry guidance with the allocated identity. Keep it when a response is uncertain.

An existing delivery_id for your agent/org returns `Already delivered` and the recorded card, without changing its bytes/note. It does not recapture an edited path. Use a new ID for a revised file. A collision with another delivery's identity refuses. Concurrent attempts select the single recorded delivery, with its event stored atomically.

Without a known delivery ID or preserved provider tool-use identity, replay after total response loss cannot be assumed deduplicated. Read available delivery/tool context before retrying. Reusing a **different** identity for the same uncertain operation can create duplicate cards.

Common refusals are missing path, nonexistent/out-of-scope source, non-file, empty/oversized file, an escaping outbox, overlong delivery_id, and an identity already used outside your own delivery scope. An I/O failure is not proof that no record exists; inspect the response's allocated identity and retry that same delivery when appropriate.

## See also

- [orgtree-reaching-the-user](../reaching-the-user/SKILL.md)
