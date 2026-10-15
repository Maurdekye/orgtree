---
name: orgtree-agent-charter-tab
description: Explain personal instructions and standing team instructions in agent settings.
---

Up: [orgtree-agent-settings](../SKILL.md)

# Charter tab

These user-edited text fields are stored with the selected agent. Agents explain and suggest edits; they do not change settings themselves.

| Control | Stored field | Meaning |
|---|---|---|
| Instructions | `node:charter` | This agent's own assignment and standing instructions. |
| Team instructions | `node:team_charter` | The standing charter this agent gives its team; the agent itself also sees it. |

Both start from the saved text, with an absent value displayed as empty. There is no stock text inserted by this tab. An empty saved field clears that text. **save** applies the text along with the other tab edits; switching tabs does not save it.

The runtime puts the personal field in the agent's startup identity as its charter. It includes the agent's own team charter and its ancestors' nonempty team charters, ordered from the root downward. A team's standing instructions therefore reach descendants at every depth. This is separate from the organization's `org.md`; see `orgtree-charters` (orgtree-working › team) for the overall instruction hierarchy.

The form warns that personal instructions restart the agent and team instructions restart the team. In the current shared scope-save path, the affected live subtree is marked for reconfiguration, including for a personal-instructions save. An idle process is replaced; an active turn finishes before replacement. New startup text changes the prompt prefix, so expect a cache compatibility cost rather than promising retained provider cache reuse.

Suggest personal instructions when the agent's own objective or constraints need clarification. Suggest team instructions when a standing rule should follow the whole subtree. Avoid copying an organization-wide rule into every personal charter; use its appropriate instruction home.

## See also

- `orgtree-charters` (orgtree-working › team).
- [orgtree-agent-config](../agent-config/SKILL.md).
