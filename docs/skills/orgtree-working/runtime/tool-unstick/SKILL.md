---
name: orgtree-tool-unstick
description: Release a descendant's usage freeze without changing its account or adding capacity.
---

Up: [orgtree-runtime](../SKILL.md)

# orgtree_unstick

Use this when a descendant's stored freeze should be released, such as after its usage reset or after establishing that the hold no longer applies. This is a manual release and does not wait for the freeze's recorded reset horizon.

## Parameter and permission

`node` is required and names one agent in your org; a leading `@` is accepted. There is no batch, account, reason, or default-target parameter.

Requires effective `tools.orgtree.runtime`. Only strict descendants are permitted. Top-level agents have the same downward-only authority. Self is refused with `you cannot unstick yourself`; peers and superiors are refused as outside your reports; an unknown/deleted name is not found.

## What changes

For a live frozen target the runtime clears `frozen` and its agent `limit_locked` flag, then sends a system wake to continue the held work, including retained request replay when present. It preserves any separate halt. Normal turn admission still applies.

The text result is either `… was released and continues its work.` or `… was not frozen; nothing to release.` A non-live target cannot be thawed. This is not a rehire.

Unstick does not add provider capacity, clear the account's capacity marks, change the account binding, or prove that the next request will succeed. If the underlying refusal remains, the agent may freeze again. Account inspection/mark handling belongs to [account marks](../../accounts/tool-account-mark/SKILL.md); an authorized account change belongs to [continue on](../../accounts/tool-continue-on/SKILL.md). Use [unhalt](../tool-unhalt/SKILL.md) for an independent halt.

## Example

```json
{"node":"worker"}
```

After an uncertain error, inspect the [agent state](../../inspection/tool-state-inspect/SKILL.md) before repeating: clearing the freeze and delivering its wake are separate steps.
