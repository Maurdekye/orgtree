---
name: orgtree-export-import-duplicate
description: "Export an agent, a team or a project to a file, import one under a node, or duplicate one: the dialogs, the plan and what to tell the user."
---
Up: [orgtree-canvas](../SKILL.md)

# Export, Import and Duplicate

Three entries of every agent's and project's context menu, in a group of their own before the entries that halt or retire. A retired node offers only **Export…**. The canvas's own menu (right-click the background) has **Import…** for the top level.

| Entry | Opens | Result |
| --- | --- | --- |
| **Export…** | The Export dialog on that node | One `.orgtree.zip` file, saved where the user chooses |
| **Import here…** | The Import dialog; what the file holds goes directly under that node | New agents and projects with their history and files |
| **Duplicate…** | The Duplicate dialog | A copy beside the original |

Agents do the same inside their own team with `orgtree_export`, `orgtree_import` and `orgtree_duplicate` (orgtree-working › inspection and team). An agent can also mail an export to another organization and the agent that receives it imports it.

In a window of an organization on a remote engine older than Orgtree 4.7.0 the entries are there, and choosing one says "Orgtree on (its name) needs updating to export, import and duplicate": that engine cannot do it, and nothing is sent to it. Update the engine.

## Export

The dialog offers **Only X** or **X and everything under it** when live nodes stand under the node, and tick boxes for what to take: scratch folders, team folders, transcripts, CLI session files, retired agents. All are ticked except retired agents. It shows how many nodes and about how many bytes the file will hold before anything is written; one export holds at most 256 GiB.

Nobody is interrupted. An agent that is mid-turn is exported as far as it had got.

**Secrets.** "Take detected secrets out" starts as App settings > Runtime > Export and import says ([orgtree-app-export-and-import](../../app-settings/app-export-and-import/SKILL.md)), off unless the user ticked it. With it off, an export that found any stops and shows what it found: the kinds with their counts, where, and whether watchdog credentials are in the file. The user then chooses **Keep them in the file** or **Export again without them**; the file is not offered before. Provider keys and sign-ins are never in an export.

When it is ready the dialog shows the size, what could not be taken (links, files that could not be read), and **Save the file…**. Closing the dialog drops the engine's copy.

## Import

Choose a file made by Export. It is sent to the engine and checked, and the dialog shows the plan before anything is created:

- where the file came from, and a warning when it was made on another computer or changed since;
- every node with its final name (a taken name is numbered: `lead`, `lead-2`), its model and grant, and each change made on the way in: tools, folders, visibility or permission mode clamped to what the node above holds;
- nodes that arrive **retired**: retired when exported, or on a model this computer cannot staff, with everything under them. Rehire them on another model afterwards;
- what it costs, and what can be drawn there.

When the saved grants cost more than can be drawn, spare credits are taken away by the strategy shown in "Take spare credits away", which starts at the app's setting and can be changed; the list updates. When not even the seats fit, the plan says so and **Import** stays off: free credits first. The organization's top-level cap also applies at the top level.

**Import** creates exactly what was shown; if something changed meanwhile it says so and shows the new plan. The agents arrive idle and are told what happened at their next turn. Their watchdogs arrive paused unless "Arm the watchdogs that can run anywhere" is ticked. Their earlier mail with anyone who was not imported, and their questions, are files in each agent's `imported-history` folder and never appear in the inbox.

If a part could not be brought in, the result lists it. Agents whose transcript is missing stay halted and are named.

## Duplicate

A second agent or project beside the original, alone or with everything under it, with the same settings, credits, folders, transcript and documents. Docket items, cost history and mail are not copied. The dialog shows the same plan as an import and the same strategy choice. The copy gets a numbered name and its watchdogs are paused, so the original's work is not done twice.

## Undo

Your own import or duplicate is one entry of the undo history: Undo retires what was created, Redo brings it back. It asks first when an imported agent has worked since, and is refused when somebody was hired under it or it was moved. What agents import with their tools is not in the history.

## See also

- [orgtree-context-menus](../context-menus/SKILL.md)
- [orgtree-app-export-and-import](../../app-settings/app-export-and-import/SKILL.md)
