---
name: orgtree-tool-fast-defaults
description: Read per-tier hiring-speed defaults and change them as a top-level agent.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_fast_defaults

Requires the team tool group. `action` is `read` (default) or `set`.
Any caller with this tool can read the org's `default_fast_mode` map. Missing
tiers are OFF. `set` requires `tiers`, an object of at most 64 known tier names
mapped to booleans. It patches those entries atomically and preserves others.
Only live top-level agents whose nearest agent superior is the user may write;
projects are transparent. Other managers receive a clear refusal.

Example: `orgtree_fast_defaults {"action":"set","tiers":{"sol":true,"luna":true}}`.
Only enable tiers whose default model supports fast mode; unsupported true,
unknown tiers, nulls and other non-booleans refuse the whole patch. False can
clear a preference after support disappears. Changes are recorded in org history.

Defaults affect future hires through hire, staff and Quick chat, with explicit
hire `fast_mode` taking precedence. A stale unsupported default is ignored at hire.
Existing agents and restored seats keep their saved choice. Use retool with
`fast_mode` to change an existing scoped report, and state_inspect to verify it.
Changing defaults does not restart CLIs or switch accounts/models/sessions.
