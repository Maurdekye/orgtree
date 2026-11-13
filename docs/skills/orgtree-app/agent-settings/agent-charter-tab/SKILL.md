---
name: orgtree-agent-charter-tab
description: Explain personal instructions and standing team instructions in agent settings.
---

Up: [orgtree-agent-settings](../SKILL.md)

# General tab

The first tab of Agent settings reads **General** (it was called Charter before 4.5.11; settings search still finds it by that name).

These user-edited text fields are stored with the selected agent. Agents explain and suggest edits; they do not change settings themselves.

| Control | Stored field | Meaning |
|---|---|---|
| Instructions | `node:charter` | This agent's own assignment and standing instructions. |
| Team instructions | `node:team_charter` | The standing charter this agent gives its team; the agent itself also sees it. |

Both start from the saved text, with an absent value displayed as empty. There is no stock text inserted by this tab. An empty saved field clears that text. **save** applies the text along with the other tab edits; switching tabs does not save it.

From 4.6.0, Save sends only the settings you edited, each with the value its edit started from. When someone else changed one of them in the meantime (another computer on the same organization, or an agent), the engine saves nothing and the form shows a notice where the Save row was: **Sam changed the instructions at 14:02. Nothing was saved.** It has three choices. **See their version** shows the stored text, and **Use theirs** takes it into the form. **Save mine anyway** saves your edits over it; it is refused again if the setting changed once more in between. **Cancel** leaves the form open with your edits, unsaved. While you are editing a text that then changes underneath, a line under it says **This changed while you were editing.** with **See the new value**. None of these throws away what you typed. An organization on an engine older than 4.6.0 saves as before, without the check.

The runtime puts the personal field in the agent's startup identity as its charter. It includes the agent's own team charter and its ancestors' nonempty team charters, ordered from the root downward. A team's standing instructions therefore reach descendants at every depth. This is separate from the organization's `org.md`; see `orgtree-charters` (orgtree-working › team) for the overall instruction hierarchy.

The form warns that personal instructions restart the agent and team instructions restart the team. In the current shared scope-save path, the affected live subtree is marked for reconfiguration, including for a personal-instructions save. An idle process is replaced; an active turn finishes before replacement. New startup text changes the prompt prefix, so expect a cache compatibility cost rather than promising retained provider cache reuse. For a Claude agent the text-only part of this is different (4.5.8): a Claude session keeps the system prompt it started with, so Orgtree does not restart the CLI for a text-only instruction change. The agent's next turn begins with one block that names only the changed sections (rules, charter, team charter, instructions for all orgs, org.md, standing notes), gives their full current text and says it supersedes the earlier text; the following turn repeats nothing. A change to tools, folders, model or account still replaces the process. The first turn after updating to 4.5.8 delivers every section once to each Claude agent whose session predates it. Codex, Muse and Antigravity agents are unchanged. Details: `orgtree-harness-claude-code` (orgtree-app > harnesses).

Suggest personal instructions when the agent's own objective or constraints need clarification. Suggest team instructions when a standing rule should follow the whole subtree. Avoid copying an organization-wide rule into every personal charter; use its appropriate instruction home.

**Subordinates may message each other** is a separate node-local switch on this tab, ON by default. OFF requires directional audiences between direct siblings and hides their neighbour lines. A peer-only save applies immediately without restarting processes or changing scope grants. It does not inherit down the tree. See `orgtree-peer-mail` (orgtree-working › team) for project settings and audience exceptions.

## See also

- `orgtree-charters` (orgtree-working › team).
- [orgtree-agent-config](../agent-config/SKILL.md).
