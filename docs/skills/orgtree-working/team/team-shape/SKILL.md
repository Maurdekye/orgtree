---
name: orgtree-team-shape
description: Define reporting and placement relationships, then choose a team-structure change without confusing capacity, session identity and saved work.
---
Up: [orgtree-team](../SKILL.md)

# Shape the team deliberately

## Relationship terms

These terms distinguish the reporting chain from the physical tree:

| Term | Meaning |
| --- | --- |
| **Superior** | Your nearest agent ancestor, skipping any intervening projects. If there is no agent above you, you are top-level and report to the user. A project is never an agent superior. |
| **Report / subordinate** | An agent whose superior is you: your **direct report**. Projects between you and that agent are transparent. These three names mean the same relationship. |
| **Descendant** | Any agent or project below a node, at any depth. A node is not its own descendant; its subtree includes itself and its descendants. |
| **Sibling / peer** | A node sharing the same physical parent. For agent peer mail, these are agents under the same actual parent; top-level agents share the user root. Sharing a superior across different projects does not make agents physical peers. |
| **Parent / child** | The immediate physical placement in the tree. Either node may be a project. A physical child project is not a report. |

Projects are transparent **for reporting**, not for physical placement. For example, with @lead → @project → @worker → @helper, @worker is a report/subordinate of @lead, and @helper is a report of @worker. All three lower nodes are descendants of @lead. @worker and an agent directly under @lead can share @lead as superior without being siblings.

Read each tool's authority separately. A descendant-wide action is not limited to reports: this includes DnD **for descendants**, whose scope remains agents at any depth. Visibility can also include agents with the same superior even when they have different physical parents; that does not grant peer-mail reach. See [chart visibility](../../inspection/tool-chart/SKILL.md) and [peer mail](../peer-mail/SKILL.md).

Some existing UI labels say **Subordinates may message each other** or **all subordinates**. Keep those exact labels when locating a control: the peer-mail setting concerns physical siblings, while bulk **all subordinates** actions cover descendants and exclude the selected root. Their tool and screen pages own the exact eligible targets. Likewise, the API value `hire_type="subordinate"` means placement under the chosen parent, which need not be the caller; it does not limit hiring to the caller's direct reports.

## Choose a structure change

Keep a team flat by default. Add a manager when coordinating the direct reports consumes too much bandwidth for one agent, rather than adding hierarchy as a formality. Before a change, identify who will own each unfinished item and where the next session will find its handoff.

Choose the operation by the intended result:

- To reclaim capacity from finished work, read [retire](../tool-retire/SKILL.md); inspect its whole-subtree warning before acting on a manager.
- To archive a team intentionally, read [dissolve](../tool-dissolve/SKILL.md).
- To bring expertise back, read [rehire](../tool-rehire/SKILL.md); restoration is a seat admission, not a resurrection of every former report.
- To change a reporting line, read [move](../tool-move/SKILL.md); for order only, read [reorder](../tool-reorder/SKILL.md).
- To exchange assigned places, read [swap](../tool-swap/SKILL.md); to step down yourself, read [self subjugate](../tool-self-subjugate/SKILL.md).
- To create a new superior, use the distinct superior-insertion rules in [hire](../tool-hire/SKILL.md).

Each tool page owns its accounting, authority and what follows a seat versus an identity. Do not treat those operations as interchangeable sequences of arbitrary parent edits. A new ancestor chain can also change effective scope, standing charters and team workspaces.

Changes that arrive together can run side by side. A retryable database
conflict is tried up to ten times in all, after rolling back the failed
transaction and waiting a randomized backoff between tries. The attempt limit
does not promise an overall completion time: database work, contention and
process shutdown still take time. A change that still collides is refused with
"… collided with other changes made at the same moment, 10 times in a row;
nothing changed. Retry it." Nothing of that refused change was applied, so the
same call can be sent again.

Nested projects stay transparent to reporting at every depth: the nearest agent
above the projects remains the superior. Runtime reports that require someone
able to act skip inactive agents to find a live superior.

Changes that arrive together run side by side, and ones that collide in the database are tried again: up to ten tries in all, each after a short random wait, so a burst of 22 retires under one parent completes in a few seconds. A change that still collides is refused with "… collided with other changes made at the same moment, 10 times in a row; nothing changed. Retry it." Nothing of it was applied, so send the same call again.

Afterward, inspect the actual chart, pending changes and credit result. File/history retention and a resumable model session are separate facts; do not claim that retained files guarantee a cache hit or a fully remembered conversation. Leave durable items and scratch handoffs current. For the user's Undo controls and their limits, see `orgtree-toasts-and-undo` (orgtree-app › app-shell); do not promise that every engine or agent-tool action has an undo gesture.

## See also

- [orgtree-tool-retire](../tool-retire/SKILL.md)
- [orgtree-tool-rehire](../tool-rehire/SKILL.md)
- [orgtree-tool-dissolve](../tool-dissolve/SKILL.md)
- [orgtree-tool-move](../tool-move/SKILL.md)
- [orgtree-tool-swap](../tool-swap/SKILL.md)
- [orgtree-tool-self-subjugate](../tool-self-subjugate/SKILL.md)
