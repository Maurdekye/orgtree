---
name: orgtree-agent-fresh-start
description: Explain fresh-start inheritance, conversation size and the current-session readout.
---

Up: [orgtree-agent-settings](../SKILL.md)

# Start fresh when needed

The Model tab's **Start fresh when needed** setting is `node:auto_cheap_compact`, stored as an optional object in agent scope. Agents explain or suggest this user setting; they do not change settings themselves.

| Control | Meaning and default |
|---|---|
| Organization default | Remove this agent's override and inherit the organization's policy. Built-in policy: off with a 25% occupancy threshold. |
| On | Enable the policy explicitly for this agent and show Conversation size. |
| Off | Disable it explicitly for this agent. |
| Conversation size | Context occupancy percentage; displayed only for explicit On. Starts from the agent's saved occupancy, else the org's, else 25%. UI range 5–95%, step 5. |

Save sends an empty object for inheritance, which removes the override. Explicit On/Off sends `enabled` and `occ`; percentage is converted to a fraction. A blank or zero form value falls back to 25%. The engine keeps numeric occupancy within 5–95% and refuses the wrong value types. The effective policy merges agent keys over org keys, so a partial stored override can inherit the other key.

The policy resets before a turn only when the cache forecast calls for compaction and measured conversation occupancy is at least the threshold, with an existing session and valid context size. Turning it on does not immediately reset the session. Unknown cache readiness and estimated context do not establish a reset condition. It is separate from the organization's ordinary context-compaction threshold.

When triggered, the current agent continues in a fresh session with a summary and attempts to save the old conversation in its scratch folder. A failed history save is logged, so do not promise an export in every failure case. Detailed cache forecasting, receipts and handoff behavior belong to `orgtree-context-and-compaction` (orgtree-working › runtime).

Suggest this override when one agent should have a different known-cold-session policy from the organization. Discuss continuity and rereading cost using the actual forecast; do not use elapsed process lifetime alone as proof that its provider cache is cold.

## Current session

**Current session** is a read-only block, shown when the chat initialization read returns data. It reports the running agent's model, permission mode, tool count and MCP server names/statuses, with connected status indicated separately. This is a snapshot loaded when the window opens for that agent; it is not a setting, a guarantee of server health, or the future configuration selected in unsaved fields. It may be absent if no initialization data was returned.

## See also

- `orgtree-context-and-compaction` (orgtree-working › runtime).
- [orgtree-org-policies-compaction](../../org-settings/org-policies-compaction/SKILL.md).
- [orgtree-agent-model-tab](../agent-model-tab/SKILL.md).
