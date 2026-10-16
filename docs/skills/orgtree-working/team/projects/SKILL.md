---
name: orgtree-projects
description: Project nodes: free, turn-less tree nodes with a folder, a mailbox shared through the fair queue, and presentations.
---
Up: [orgtree-team](../SKILL.md)

# Project nodes

A **project node** stands for one project in the tree and is not an agent. It runs no turns, acts for nobody and costs nothing. It sits in the tree like any node: agents and other projects hang under it (projects nest), it can be moved, renamed, reordered, retired and restored. The canvas draws it as a dashed card with a folder mark, and the user creates one with the hire strips' light grey project token (`orgtree-draft-hires`, orgtree-app › canvas). `orgtree_chart` and `orgtree_state_inspect` mark it `project`.

## Who reaches a project

The user, every agent **above** the project and every agent **below** it reach it; agents beside it (peers, cousins) do not. Reaching it means its folder, its mailbox, its presentations, and control over the project node as if it were your subordinate: rename, reorder, retire or move it, nest a project in it. Control covers the project itself, not the other agents inside it, and an agent cannot retire a project it is inside (its superiors can).

## Reporting and credits

The agents under a project **report to the nearest agent above it**: that is "your superior" in their instructions, where their status notices go, and whom the superior/peer mail rules use. Agents under a top-level project are top-level agents. Credits are transparent too: the agent above the project pays for every agent under it, so only an agent above a project can hire under it. See [orgtree-credits](../credits/SKILL.md).

## Folder and AGENTS.md

A project's folder is `<data>\scratch\<org>\_teams\<project id>`. Every agent under it holds that folder and gets its `AGENTS.md` at session start, labelled as the project's, the way team notes arrive. Every agent above it holds the folder too (its instructions list the projects below it) but does not get the notes.

## The mailbox and the fair queue

Write to a project with `orgtree_message` to its name. Its mail wakes nobody: it waits in the project's mailbox until an agent that reaches the project watches it with an `orgtree_watchdog` of kind `fair_queue` (target: the project's name). Each waiting mail then goes to **exactly one** watcher, the least recently woken (one never woken first, ties to the oldest watcher), as ordinary mail from its original sender, marked as coming via the project; the project's copy is marked read. Busy, halted and frozen watchers keep their turn; the mail waits in their mailbox. The first watcher to arm gets any backlog. `orgtree_inbox action=list|fetch project=<name>` shows what waits without claiming it.

## Presentations

`orgtree_present project=<name>` puts a document under the project instead of beside your seat (the same user-audience rule applies). The project's card and the presentations gallery show it under the project.

## See also

- [orgtree-tool-project](../tool-project/SKILL.md)
- [orgtree-team-shape](../team-shape/SKILL.md)
- [orgtree-credits](../credits/SKILL.md)
