---
name: orgtree-visibility
description: Understand inherited org visibility and why inspection tools expose different permitted views.
---

Up: [orgtree-inspection](../SKILL.md)

# Visibility

Org visibility is a capability ordered `self` → `team` → `subtree` → `full`. Its effective value is the narrowest value up the ancestor chain. A child's configured choice cannot expand a superior's effective visibility, and top-level position alone is not a full-org grant.

Missing per-agent visibility is normalized to `subtree`; the org's hire default and the UI fallback are separate settings, described by `orgtree-org-hire-defaults-scope` (orgtree-app › org-settings). Consult the effective value rather than assuming a displayed draft or default has already been granted.

## Choose the view for the question

The [chart](../tool-chart/SKILL.md) owns the exact self/team/subtree/full roster table, archive option and output limits. It is the view for human-readable team shape and reported status. Hidden intermediates can be omitted from that projection.

[State inspection](../tool-state-inspect/SKILL.md) deliberately permits all descendants even at self visibility, in addition to the chart-related superior/peer access described in its tool page. This is why a missing chart row is not proof a descendant's state is unreadable. Effective folders and permissions are returned through that structured view.

[Transcript](../tool-read-transcript/SKILL.md) and [scratch](../tool-read-scratch/SKILL.md) reads use a self-or-descendant relationship, not full-org chart visibility as a blanket content grant. A visible peer is not thereby a readable conversation or folder. The tool pages own exact bounds and refusals.

An [audience](../../mail/tool-audience/SKILL.md) is permission to communicate; it does not silently widen inspection. Folder, native-tool, MCP and Orgtree-group permissions are separate dimensions, described in [scope and permissions](../../team/scope-and-permissions/SKILL.md). If a read is refused, identify which dimension actually blocks it before requesting broader scope.

## See also

- [orgtree-tool-chart](../tool-chart/SKILL.md)
- [orgtree-scope-and-permissions](../../team/scope-and-permissions/SKILL.md)
