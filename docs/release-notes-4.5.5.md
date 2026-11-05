# Orgtree 4.5.5

Orgtree 4.5.5 lets projects own watchdogs, relay one project's queue into another and hold the org inbox. It adds Streamer mode and Attract mode, an Activity tab showing where each agent's time went, folding a subtree on the canvas, and project icons and colours. It still bundles Mail hub 2.4.0.

## Projects and queues

- **Projects can own watchdogs.** A watchdog created on a project fires the project's event for its listeners. It can also mail every agent directly under the project (broadcast), or put each fire in the project's queue as a job. The project desk shows these watchdogs as cards and in a new **Event sources** section on the Listeners tab.
- **Relay one project's queue into another.** A queue watchdog on project Q with target project P makes Q take jobs from P's queue and queue each one as its own. The job in P stays claimed until Q's worker has finished with it, then it is acknowledged for you. The worker who takes it can answer the original sender, outside ones included, and that sender's follow-ups find the worker. Relays can chain (P to Q to R). A relay that would close a loop is refused. **Recently Delivered** shows a relay's hand-outs as "project (relay)", and a relayed job names where it came from.
- **A project can hold the org inbox.** Each outside message becomes one job in the project's queue instead of a copy for every holder. The worker who takes it replies to the outside sender until it acknowledges the job, and the sender's follow-ups are bundled with the waiting job or go to the worker holding it. The project's Mail tab marks those follow-ups. Retrying a dead letter brings its follow-ups with it.
- **Reply about a job.** An agent that is handed a project job can reply to that job's sender, even with no other audience, until it acknowledges the job (in round-robin mode, at any time). The sender can reply back the same way.
- **Queue many jobs at once.** An agent can queue up to 1,000 jobs on a project in one message: a list of job texts, a template with rows, or a file (JSON, JSON Lines, CSV or plain lines). A batch key makes a retry safe after a lost answer: jobs already queued aren't sent twice.

## Watchdogs and audiences

- **Set up a watchdog for a report.** A superior can create a watchdog owned by an agent below it, so the report is woken when the condition fires without spending a turn to set it up. It runs with the report's own tools, and the report is told who created it. The desk shows a dim "created by" line.
- **Edit a watchdog in place.** Watchdogs can be changed without recreating them: target, pattern, timing, credentials, fire actions and the rest. The checks a new watchdog gets run again for the edit. The fire count, history and creator are kept.
- **Grant audiences further down.** Any agent above two agents can now grant, deny or revoke an audience between them, at any depth and across projects, not only their nearest common superior.

## Agents' time

- **Activity tab.** Agent settings has a new **Activity** tab, just before History. It shows how long the agent was active, idle, blocked, halted or frozen over the last 24 hours and 7 days, then each span newest first with its start time and a bar for its length. It loads older spans as you scroll and updates live. The bar scale grows with the agent's age: a week, then a month, then a year.
- **State changes in the transcript.** Each time an agent's state changes, its Chat gains one compact line naming the state that ended and how long it lasted. Hover it for the exact time. A state under a second leaves no line.
- **Agents can read it too.** An agent can read another agent's activity history it can see, so it can tell whether a report is stuck or idle without reading its conversation.

## Streamer mode and Attract mode

- **Streamer mode hides private details on screen while you stream.** It blurs local file paths (off by default), IP addresses, email addresses, secrets and keys, phone numbers, token URLs, outside addresses and the names of other orgs, each with its own switch. Only the matching text is blurred, not the window. HTML apps, HTML presentations, images and videos get a cover you can dismiss one at a time. Nothing appears while it is still being written, so half a key never shows. A banner says Streamer mode is on, with **Turn off**.
- **It can turn itself on while OBS runs.** **Turn on automatically while OBS is running** (on by default) switches Streamer mode on while OBS, Streamlabs, XSplit or another streaming app is running, and back off when the last one closes. It never turns off a Streamer mode you turned on yourself.
- **It is on screen only.** What you copy, what agents receive and what is stored are unchanged, so a copy can still contain the original value. The system's open and save dialogs aren't covered.
- **Attract mode lets an idle window show the organization at work.** After a window has had no input for its start time (five minutes by default, set in seconds), it moves between agents with new activity, new mail to you, new or updated presentations and changed tickets, opening each ticket at its change, and keeps coming back to the whole organization. Anything that needs your attention comes first. It never moves keyboard focus or touches a desk that is open in another window, and any canvas input stops it. While it runs, agents' new questions to you can be refused, and the agent is told to message you on Hubchat instead (on by default).
- Both are in the new **App settings > Streaming** page, and every open window follows them.

## Canvas and desks

- **Fold a subtree.** Right-click any agent or project with members and choose **Collapse subtree**. The branch leaves the canvas and the layout closes the gap. A small stack under the node shows its first children in their colours and how many are hidden: click it to unfold. A folded node still looks busy while any hidden member is working, and glows while any has a question or an unseen mention for you. The choice is saved per organization.
- **Project icons and colours.** In Project settings, pick an icon from the built-in set or upload your own, and a theme colour. The icon replaces the folder wherever the project appears: on the canvas, its card and desk, @project links, the @ menu and the hire-under chip. The colour tints the project's node.
- **More text is formatted.** Thoughts, slash-command output, compaction summaries, docket text, the project Summary, the tray's status summaries, answered questions and app descriptions now use the same formatting as Chat (Markdown, links, math).
- **Reply quotes are simpler.** A quoted reply block is itself the jump to the original, with no separate "jump to message" label, and quotes of agents' messages use the mail reply's frame.
- **A desk open in another window** shows one compact "in another window" chip on its card.
- **A selection in a transcript stays put** while new events arrive.
- The Apps list shows whether an app is running as a coloured left edge, like its links, instead of filling the row.
- Agent settings tabs now line up, with no extra padding on History or Activity.

## Fixes

- Project presentations can be updated by any agent allowed to present into the project, and the reader and list say "presented by" consistently.
- Open Usage and Usage history panels update when accounts are turned off or on, including pinned and popped-out ones.
- A folded project still shows that a hidden member is working.
- An agent's thinking timer no longer keeps redrawing once its thought text is showing.
- To help find intermittent UI freezes, the desktop app now records any freeze of half a second or more to `diagnostics/ui-stalls.jsonl` in its data folder. It records timings and counts, never message text.

## Untested

- The project queue relay and projects holding the org inbox have been tested by automated tests with synthetic organizations and simulated outside mail only, not with real outside contacts.
- Streamer mode's automatic start has been tested by automated tests only, not with a real OBS session.

## Notes

- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
