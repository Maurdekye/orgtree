---
name: orgtree-projects
description: Project nodes: free, turn-less tree nodes with a folder, a mailbox shared through the fair queue, and presentations.
---
Up: [orgtree-team](../SKILL.md)

# Project nodes

A **project node** stands for one project in the tree and is not an agent. It runs no turns, acts for nobody and costs nothing. It sits in the tree like any node: agents and other projects hang under it (projects nest), it can be moved, renamed, reordered, retired and restored. The canvas draws it as a dashed card with a folder mark, and the user creates one with the hire strips' project token (a square in the card's theme colours) (`orgtree-draft-hires`, orgtree-app › canvas). `orgtree_chart` and `orgtree_state_inspect` mark it `project`.

## Who reaches a project

The user, every agent **above** the project and every agent **below** it reach it; agents beside it (peers, cousins) do not. Reaching it means its folder, its mailbox, its presentations, and control over the project node as if it were your subordinate: rename, reorder, retire or move it, nest a project in it. Control covers the project itself, not the other agents inside it, and an agent cannot retire a project it is inside (its superiors can).

## Reporting and credits

The agents under a project **report to the nearest agent above it**: that is "your superior" in their instructions, where their status notices go, and whom the superior/peer mail rules use. Agents under a top-level project are top-level agents. Credits are transparent too: the agent above the project pays for every agent under it, so only an agent above a project can hire under it. See [orgtree-credits](../credits/SKILL.md).

## Peer mail among direct members

Project Settings has [Subordinates may message each other](../peer-mail/SKILL.md), ON by default. OFF requires an active directional audience between agents directly under this project and hides their ordinary neighbour connector lines. It does not change the project's mailbox or fair queue, the reporting superior, deeper teams, chart visibility or docket access.

A committee without a dedicated manager uses a project with every member directly under it and this setting OFF. A large or complex committee may instead hire a dedicated manager and place members directly under that manager, with no committee project; apply the manager's peer-mail setting OFF to preserve independence. Members send proposals and questions only to the committee supervisor; do not grant or use an audience for member-to-member contact. Follow `orgtree-committee-mode` (orgtree-workflows › collaboration-patterns) for both hosting forms, independent rounds and consensus.

## Folder and AGENTS.md

A project's folder is `<data>\scratch\<org>\_teams\<project id>`. Every agent under it holds that folder and gets its `AGENTS.md` at session start, labelled as the project's, the way team notes arrive. Every agent above it holds the folder too (its instructions list the projects below it) but does not get the notes.

## Description

A project's description is the standing charter of every agent under it, nested projects included: their instructions carry "Standing charter from project <name>: …" beside their superiors' team charters, outermost first. A CLI that is already running picks it up at its next start.

## The mailbox and the fair queue

Write to a project with `orgtree_message` to its name. Its mail wakes nobody: it waits in the project's mailbox until an agent that reaches the project watches it with an `orgtree_watchdog` of kind `fair_queue` (target: the project's name). Each waiting mail then goes to **exactly one** watcher, the least recently woken (one never woken first, ties to the oldest watcher), as ordinary mail from its original sender, marked as coming via the project; the project's copy is marked read. Busy, halted and frozen watchers keep their turn; the mail waits in their mailbox. The first watcher to arm gets any backlog. `orgtree_inbox action=list|fetch project=<name>` shows what waits without claiming it.

The queue has a mode, set in the project's settings ("Mail queue"):

- **Round-robin** (the default): each mail goes out as soon as it arrives, as above. No ack is needed.
- **Ack mode**: each watcher holds ONE handed mail and gets no more until it acks it: `orgtree_message to=<project> reply_to=<the id of the mail you were handed>` with a short completion record. The ack is kept in the project's mailbox as a read record, and if mail is waiting the ack hands you the next one at once. Acking the same mail twice, or a mail already taken back, is refused. A halted watcher is handed nothing in ack mode.

Every handed mail's wrapper says whether it needs an ack and how, and every watcher gets a notice when the mode changes. In ack mode an un-acked mail goes back to the **front** of the queue when its holder is retired, halted or stops watching (its fair_queue dog paused or removed). With the ack timeout on (the default), an agent sitting on an un-acked mail gets the 20-minute working checkup up to 3 times, naming the mail and how to ack it; at the next one the mail is taken back. A mail handed out **max attempts** times (default 3) without an ack goes to the dead-letter list instead, and the project's superior (the user, for a top-level project) is told. The timeout and max attempts need Runtime's 20-minute checkup to be on (it is by default). "Never hand an agent its own mail" (off by default) keeps a watcher's own mail to the project from being handed back to it. The project desk's inbox shows each mail's state (to whom, awaiting ack, acked, released, dead letter, purged) and can purge the mail still waiting. For running a project as a work queue, see `orgtree-work-queues` (orgtree-workflows › collaboration-patterns).

## Slots

A project can also give out **slots**: a count in Project settings (0, the default, is none) of agents that may hold its slot at once, for work only that many may do at a time, such as a heavy build. Agents above or below the project claim one with a one-shot `slot` watchdog (see `orgtree-tool-watchdog`): granted at once while a slot is free, otherwise a place in a strictly first-come line that fires when granted. Release with `orgtree_project action=release_slot lease=<lease>`; the next in line is granted at once. A retired or halted holder loses its slot, and an idle one is reminded by the 20-minute checkup and loses it after 3 reminders (with the project's ack timeout on), as un-acked mail does. Leases and the line survive restarts. `orgtree_project action=slots name=<project>` lists the holders, the line and recent holds; the project's superior and the user can force-release a slot or remove an agent from the line. On the desktop, a project with slots has a **Slots** tab on its desk (the holders, the line with how long each has waited, and recent holds with how each ended; force release asks first) and a "slots held/total" card in the desk header that opens it. Its card shows "1/1 held · 2 waiting", filled when every slot is held and outlined while one is free. A holder's card has an amber "⬢ build #1" chip in its chip row, and a waiting claim's watchdog chip reads "⏳ build 1st"; the agent's desk header shows both, the holder's and the waiting "⏳ build 1st", right after the cost chip. There is no resource gate: a holder that needs free memory waits on its own memory watchdog, and may lose the slot meanwhile. For the build-machine recipe, see `orgtree-build-slots` (orgtree-workflows › collaboration-patterns).

## Docket items

A project's docket lists every item owned by an agent under the project, nested projects included: the project desk's docket tab and "Open → Project docket" in its menu. Items are not attached to a project, and nobody co-owns an item because of one; give an item an owner under the project to put it on that docket. (`orgtree_work` refuses a `project` argument.)

## Presentations

On the canvas, each agent with a fair_queue watchdog on a project has a rose line to that project; a paused watchdog's line is dashed and dimmer. A slot holder's line to the project is solid amber, a waiting claim's dashed amber. An agent's several lines to one project (its audience, its fair_queue listener, its slot) run side by side, never on top of one another.

The project desk's message box sends the user's mail to the project's own mailbox by default. If nobody watches the project with a fair_queue dog, one agent directly under it (an idle one first) is woken and asked to arm one: arming it hands you the waiting mail. With the megaphone on, the box instead sends the same message (attachments and notice flag included) to every live agent under the project, nested projects included, one delivery each.

`orgtree_present project=<name>` puts a document under the project instead of beside your seat (the same user-audience rule applies). The project's card and the presentations gallery show it under the project. The project's own gallery (its desk's presented tab and "Open → Presentations" in its menu) lists the documents attributed to the project. Its team presentations ("Open → Presentations → Team presentations") add every document presented by the agents below it, nested projects included, and so do the presentation chips on its card and desk header. A document presented under the project names the project as its presenter, with a "presented by <agent>" line for the agent that presented it. An agent's "Open → Presentations → Team presentations" covers its whole team the same way, through projects.

## See also

- [orgtree-tool-project](../tool-project/SKILL.md)
- [orgtree-team-shape](../team-shape/SKILL.md)
- [orgtree-credits](../credits/SKILL.md)
