---
name: orgtree-tool-request-scope
description: Request specific folder, tool-group, MCP or permission-mode access and understand normalization, batching and superior fallback.
---

Up: [orgtree-user](../SKILL.md)

# orgtree_request_scope

Use when the task actually needs access you do not hold. This creates a request, not a grant. For permission to contact a recipient use [orgtree_audience](../../mail/tool-audience/SKILL.md); a communication audience and a folder/tool grant are different.

Required tool group: `user`, intersected through your ancestor chain. Top-level agents and live, unpaused user-audience holders place scope tabs on the user's desk. Without the audience, remaining requested items are sent to your direct superior as mail instead. A denied user tool group cannot be bypassed by invoking this tool to grant itself.

## Parameters and item forms

`items` is required, with one to eight objects per call. `reason` is required nonblank text explaining what the access is for. Each object requires `kind` and the fields for that kind:

| Kind | Fields and defaults |
| --- | --- |
| `dir` | `path`: nonblank absolute folder path; `mode`: ro or rw, default rw. The tool normalizes text but does not itself give filesystem access. |
| `tool` | `tool`: bash, web, edit, subagents, or an exact orgtree group name listed below. |
| `mcp` | `server`: nonblank MCP server name. |
| `permission_mode` | `mode`: plan, default, acceptEdits or bypassPermissions. No default; an unknown/blank mode refuses. |

The valid group requests are `orgtree.docket`, `orgtree.team`, `orgtree.messaging`, `orgtree.inspection`, `orgtree.watchdogs`, `orgtree.runtime`, and `orgtree.user`. Request a group with `kind: "tool"`, not an individual `orgtree_*` tool name. A server request authorizes that MCP name; it does not install/configure a server or prove the harness can connect.

Minimal folder request using the actual needed absolute path:

```json
{"items":[{"kind":"dir","path":"D:/project","mode":"ro"}],"reason":"Read the existing implementation needed for the assigned review."}
```

## Already-held access and amendments

The handler computes effective scope through organization and ancestor ceilings before requesting. It drops items already held: matching folder path with adequate mode, enabled built-in/group tool, an allowed MCP name or wildcard, or a permission mode at least as broad in the supported order. If all are held, it succeeds with `You already hold everything you asked for; nothing to request.` No card/mail is created.

For user-card requests, remaining items merge into the scope part of your one open [request batch](../tool-ask/SKILL.md). Same identity amends in place: folder path, tool name, server name, or the single permission-mode slot. The latest value wins while preserving the first slot. The combined pending scope list is capped at eight items; exceeding it refuses and preserves the earlier request. New reason text replaces the scope part's reason; question and credit parts remain.

Without a user audience, the tool sends the still-needed items/reason to the superior with structured context. That is a mail fallback, not an open user card, and [withdraw](../tool-withdraw-ask/SKILL.md) cannot retract it.

## Outcomes and refusals

End your turn after submitting when the decision is the next dependency. The answer arrives as mail. The user can decide individual scope items; request creation alone changes no authority. Inspect the effective result after approval: inheritance and clamping matter, and an intended rw folder can land ro under the actual applicable ceiling. Do not claim the requested scope was granted solely because a submit succeeded.

Common refusals are missing reason, empty items, more than eight call/pending items, unknown kind, missing folder path/server/tool, mode other than ro/rw, unsupported tool/group, unsupported permission mode, non-live requester or incomplete/overdeep ancestry. Give exact supported strings and only the fields for the intended kind. There is no node/target parameter: this requests your own scope, not a descendant's settings.

Use [orgtree_withdraw_ask](../tool-withdraw-ask/SKILL.md) when the whole user request becomes moot, remembering it also withdraws questions and credits. A partial grant or denial is not permission to modify settings yourself or reach outside the resulting folder/tool authority.

## See also

- [orgtree-reaching-the-user](../reaching-the-user/SKILL.md)
