---
name: orgtree-export-import-duplicate
description: "Export an agent, a team or a project to a file, import one under a node, or duplicate one: the dialogs, the plan and what to tell the user."
---
Up: [orgtree-canvas](../SKILL.md)

# Export, Import and Duplicate

Three entries of every agent's and project's context menu, in a group of their own before the entries that halt or retire. A retired node offers only **Export…**. The canvas's own menu (right-click the background) has **Import…** for the top level.

| Entry | Opens | Result |
| --- | --- | --- |
| **Export…** | The Export dialog on that node | One `.orgtree.zip` file; the Save dialog opens by itself when it is finished |
| **Import here…** | The Import dialog; what the file holds goes directly under that node | New agents and projects with their history and files |
| **Duplicate…** | The Duplicate dialog, or nothing when there is nothing to choose | A copy beside the original |

Agents do the same inside their own team with `orgtree_export`, `orgtree_import` and `orgtree_duplicate` (orgtree-working › inspection and team). An agent can also mail an export to another organization and the agent that receives it imports it.

In a window of an organization on a remote engine older than Orgtree 4.7.0 the entries are there, and choosing one says "Orgtree on (its name) needs updating to export, import and duplicate": that engine cannot do it, and nothing is sent to it. Update the engine.

## Export

The dialog offers **Only X** or **X and everything under it** when live nodes stand under the node, and tick boxes for what to take: scratch folders, team folders, transcripts, CLI session files, retired agents. All are ticked except retired agents. It shows how many nodes and about how many bytes the file will hold before anything is written; one export holds at most 256 GiB.

Nobody is interrupted. An agent that is mid-turn is exported as far as it had got.

**Secrets.** "Take detected secrets out" starts as App settings > Runtime > Export and import says ([orgtree-app-export-and-import](../../app-settings/app-export-and-import/SKILL.md)), off unless the user ticked it. With it off, an export that found any stops and shows what it found: the kinds with their counts (watchdog credentials among them) and where. The user then chooses **Keep them** or **Export without them**; the file is not saved before. Provider keys and sign-ins are never in an export.

When it is finished the dialog closes and the Save dialog opens by itself, in Downloads, with the file's name. With no secrets found there is nothing in between. A toast says the size and how many things could not be taken (links, files that could not be read). The engine drops its copy when the file is saved, or after a day. If the file cannot be fetched, the dialog stays and says why, with **Save the file…** to try again.

## Import

Choose a file made by Export. It is sent to the engine and checked, and the dialog says the plan before anything is created, in one sentence: "Creates lead-2 and 3 more under boss. Costs 14 credits." A taken name is numbered (`lead`, `lead-2`). It adds:

- a warning when the file is from another computer or was changed;
- "N spare credits are taken away" when the saved grants cost more than can be drawn. Only the total is said. Which agents give them is the strategy of App settings > Runtime > Shrink grants that do not fit; the dialog does not ask;
- "N arrive retired": nodes retired when exported, or on a model this computer cannot staff, with everything under them. Rehire them on another model afterwards;
- **notes**, folded: each other change on the way in (tools, folders, visibility or permission mode clamped to what the node above holds), and why a node arrives retired.

When not even the seats fit, the plan says so and **Import** stays off: free credits first. The organization's top-level cap also applies at the top level.

**Import** creates exactly what was planned; if something changed meanwhile it says so and shows the new plan. When it is done the dialog closes: the new nodes are on the canvas and a toast says what was imported, with **Undo**. The agents arrive idle and are told what happened at their next turn. Their watchdogs, and those a project owns, arrive paused unless "Arm its watchdogs" is ticked (shown when the file holds any). The org mailbox never comes with an import or a copy: whoever holds it here keeps it, and a node that held it where it was exported has to be given it again. Their earlier mail with anyone who was not imported, and their questions, are files in each agent's `imported-history` folder and never appear in the inbox.

If a part could not be brought in, the toast lists it. Agents whose transcript is missing stay halted and are named there. An import that fails keeps its dialog and says why.

## Duplicate

A second agent or project beside the original, alone or with everything under it, with the same settings, credits, folders, transcript and documents. Docket items, cost history and mail are not copied. A node with nobody under it, whose plan fits as it is, is copied at once with no dialog. Otherwise the dialog asks how much to copy and says the plan in a sentence, as an import does. Then the canvas is back, with a toast and **Undo**. The copy gets a numbered name and its watchdogs are paused, so the original's work is not done twice.

## Undo

Your own import or duplicate is one entry of the undo history: Undo retires what was created, Redo brings it back. It asks first when an imported agent has worked since, and is refused when somebody was hired under it or it was moved. What agents import with their tools is not in the history.

## See also

- [orgtree-context-menus](../context-menus/SKILL.md)
- [orgtree-app-export-and-import](../../app-settings/app-export-and-import/SKILL.md)
