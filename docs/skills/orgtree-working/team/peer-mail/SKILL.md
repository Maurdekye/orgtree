---
name: orgtree-peer-mail
description: Explain the per-manager or project peer-mail switch, its direct-child boundary and directional audience exceptions.
---
Up: [orgtree-team](../SKILL.md)

# Subordinates may message each other

Project nesting does not cut off mail to an agent superior or a descendant.
The command chain is resolved at its full depth; the physical-sibling rule
below still governs peer mail.

This node setting is ON by default. In an agent's Settings it is on the Charter tab; a project's Settings is available from its card or list menu. Its saved ON/OFF state also appears in the chart/team view. It belongs to that node, is retained across restart or retirement, and is not inherited by its children.

When OFF, two agents with the same actual, non-null parent cannot send each other messages, questions, requests or notices without an active audience in the sending direction. The refusal names the parent and **Subordinates may message each other**. The current parent's setting applies after a move. A child's own setting controls its own children, not its peers.

An audience still opens the granted direction. A peer may request one even while ordinary peer mail is blocked. Their nearest agent superior may grant `from=A target=B` when A and B share an actual parent, including agents directly under the same project. That lets A write to B; the reverse needs its own grant. Existing audience grant routes stay available.

A project is transparent for reporting, but not for ordinary coworker mail. Agents under different actual parents need a directional audience even when they report to the same superior. A project-to-project audience connects the two projects' direct live members only while **both projects' peer-mail switches are ON**. Turning either OFF suspends that bridge; it does not revoke the grant. An explicit agent-to-agent, agent-to-project or project-to-agent grant keeps its ordinary directional override. Nested project members do not inherit a parent's bridge.

Superior/descendant reach, user and outside-mail audience requirements, chart visibility and docket reading keep their separate rules. Sharing a reporting superior does not itself authorize cross-project mail.

OFF also hides ordinary neighbour connector lines between that node's direct children, in row/circular charts, at every zoom level and in both GL and SVG rendering. Hierarchy and audience lines keep their normal behavior. ON restores the neighbour links.

A peer-mail-only settings save applies immediately without restarting agents or changing folder/tool scope. Each turn's live org-state text reports the direct parent's current setting; do not infer current reach from an old static prompt or an earlier grant notice.

## See also

- [orgtree-tool-message](../../mail/tool-message/SKILL.md)
- [orgtree-tool-audience](../../mail/tool-audience/SKILL.md)
- [orgtree-projects](../projects/SKILL.md)

- [orgtree-delegating](../delegating/SKILL.md)
