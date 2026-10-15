---
name: orgtree-tool-reorder
description: Set a live descendant's final sibling position without changing its parent, scope or credits.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_reorder

Requires `team`. Required `node` names a live descendant, and required `index` is its zero-based **final** position. Inspect [state](../../inspection/tool-state-inspect/SKILL.md) first for `sibling_index` and `live_sibling_count`.

Conceptually remove the target, then insert at `0..remaining_count`; the final value appends. With four live siblings including the target, valid final indices are 0–3. Archived siblings consume no index. A same-position request preserves visible order but still writes the placement; the handler does not report an unchanged flag. The engine can renumber internal sibling order values while preserving the intended visible order.

The parent, scope, seat and grant remain unchanged. Self, superior, peers, unrelated agents and archived targets are refused. A top-level caller cannot reorder its top-level peers. `parent`, `new_parent`, `target` and `above` are not placement options here and are explicitly refused; use [move](../tool-move/SKILL.md) to change parent. Fractional, negative, missing and out-of-range indices are refused rather than guessed.

```json
{"node":"draft-checker","index":0}
```

This places an authorized live descendant first among its existing live siblings. Check the returned final `index`, `sibling_order` and `live_sibling_count`; do not infer a parent change from visual position alone.
