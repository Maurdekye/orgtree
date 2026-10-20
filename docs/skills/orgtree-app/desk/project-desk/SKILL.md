---
name: orgtree-project-desk
description: Explain project desk tabs, mail workers and history, slots, event listeners, dead letters and remembered navigation.
---
Up: [orgtree-desk](../SKILL.md)

# Project desk

Select a project on the canvas to focus its desk. **Open > Desk** opens its modal; the desk can also be pinned or popped out. These surfaces share the same project views. A project has a mailbox and team but runs no conversation or turns itself.

With **show agent card shortcuts** on, the project card's hover row opens its docket, mail, presented, team and slots windows, and its desk on the listeners tab. Team, slots and listeners appear only while the desk offers those tabs (see the table below). The row hides while the desk is open on the canvas or its pinned placeholder holds the card.

The header shows active/hired agents through nested projects, activity age, settings and the available team lifecycle controls. Header cards open the mail queue, event listeners or slots; held audiences appear alongside them. Superior jump cards stay below the header, and member jump cards above the composer, on every tab. The composer sends to the project mailbox by default; its megaphone broadcasts to live agents under the project. Notice, attachments and reply previews work as on an agent desk. Projects have no model, effort, account or credit controls.

When broadcast is off and no mail listener is attached, a compact warning above the message box says "Messages sent here may not be read by anyone". Turn on **broadcast** with the megaphone (Alt+B) to send to all project participants. The warning disappears while broadcast is on or an armed or paused `fair_queue` mail listener is attached. Event listeners do not receive inbox mail and do not dismiss this warning. It uses the same warning line as the agent desk's cheap-compaction warning.

## Tabs

| Tab | Contents and availability |
| --- | --- |
| summary | Project Summary: Markdown when unfocused, editable text when clicked. Leaving the editor saves a change; Escape discards the edit. Retired projects show it read-only. |
| mail | Project inbox, sent and listeners folders. Reading a project message does not claim or acknowledge its queue job. The separate project Mail window uses the same view. |
| docket | Items owned by agents under this project, through nested projects. A project owns no items itself. |
| presented | The project-scoped gallery, including its subtree's documents. Unlike an agent gallery, there is no Team checkbox. |
| team | The descendant Agents List. Appears while the node has live direct subordinates; its badge counts those direct nodes, including projects. |
| slots | Appears while configured concurrency-slot capacity is greater than zero. |
| dead letters | Appears while the project has open dead letters. |
| listeners | Appears exactly while the project's **Event listeners** setting is on (Project settings). It is off by default; an agent registering an event listener or listener watch switches it on, and only you or an agent above the project switch it off. Its badge counts armed event listeners. |

The Summary is the project's standing team charter; policy and tool authority are documented in `orgtree-projects` and `orgtree-tool-project` (orgtree-working › team). For shared mail, docket, gallery and Team controls, follow the links below.

## Mail > listeners: workers taking queue jobs

This folder lists `fair_queue` watchdogs that receive the project's mail. It is separate from the **listeners** tab, whose watchdogs wait for fired project events.

| Section | What it shows |
| --- | --- |
| Working | ACK mode only: one row per currently held job, its agent, wait and hold durations, job link and watchdog. **take back** asks for confirmation before reclaiming that job. |
| Line | Mail listeners in delivery order. Position and state distinguish eligible listeners from paused or otherwise unavailable ones. Batch is the maximum batch size, and Handed counts mail assigned to that watchdog. |
| Dead Letter Line | Appears while matching event watchdogs listen for this project's dead-letter events. These are notification subscribers, not the failed jobs themselves. Paused subscribers remain visible. |
| Recently Finished | ACK mode: ended jobs, newest first. Mail and Ack link to the job and acknowledgement in the project's mailbox. Failed, taken-back and dead-letter endings have distinct words/colours; an ordinary acknowledgement shows its reply. |
| Recently Delivered | Round-robin mode: individual hand-outs and how long ago they were delivered. Delivery does not establish task completion. |

Waited measures the listener's wait before assignment; Held measures its time holding the job. A listener's current waiting interval starts at its latest arming, hand-out, fire or released-job ending as applicable. Watchdog chips retain historical identities when a dog no longer exists. Older history loads as the table's final row comes into view; a failed read offers Retry.

**take back** is available to the user and project ancestors. It puts a held job at the front of the queue, preferring a different listener for its next assignment and falling back to the same one. If the job has exhausted its attempts with timeout/checkups enabled, it goes to dead letters instead. The former holder is told to stop and cannot acknowledge that reclaimed assignment. This does not terminate its process: coordinate any work already in progress before another worker repeats it.

## Project settings: Acknowledgement

This section appears in ACK mail-queue mode or when the project has concurrency slots. **Ack timeout** and **Ack reminders** apply to both un-acked mail jobs and idle slot leases. With Runtime working checkups and Ack timeout on, the holder gets the configured number of 20-minute checkup reminders (1–10, default 3); the next checkup reclaims the mail or releases the whole slot lease, including every slot in it, and checks the waiting line.

**Max attempts** is mail-only: a reclaimed job that has exhausted its hand-outs goes to dead letters. It does not limit slot claims. The immediate **turn-end reminder** is also mail-only; slot leases use the working-checkup reminders. Turning off working checkups makes the checkup-based controls inactive.

## Slots

One table separates **Holding**, **Line** and **Recently Held**. Columns include Position, Agent, Waited, Held, Ended, **Lease**, Slots, **Watchdog** and Action. Lease identifies the reservation; Slots is its quantity, which may exceed one. A grant reserves the whole quantity together. The Watchdog column names the claim dog, including its retained identity after a one-shot claim has been spent.

Holding shows current reservations and offers **force release** with confirmation. Line shows queued claims and **remove from line**. Recently Held shows ended leases, their wait and hold durations, ending age and dog. Ordinary releases have no extra ending label; unusual endings show labels such as forced or timed out. Scroll to load older holds, or Retry after a read failure.

Force release returns all units in that lease and checks the FIFO line; the head must fit in full. Removing a queued claim does not release a held lease. Neither action stops a holder's process. Use the project's current agreement for resource policy and recovery. Agent tool permissions and lease visibility differ from this user desk; see `orgtree-tool-project` (orgtree-working › team).

## Listeners: project events and Recently Fired

The **fire event** control sends its optional message to currently armed project-event listeners. It does not deliver old events to listeners that register later. While the project's event listeners are off, the tab is hidden and the event cannot be fired. Switching them off disables every event listener and listener watch on the project: each stops listening, loses its canvas line, shows a dimmer ⊘ chip whose tooltip and detail say why, and its owner is told; switching them on again re-arms those dogs, not ones their owners paused. **Event listeners** lists `project_listener` dogs; **Listener watches** lists dogs waiting for a specified armed-listener count. The table shows wait age, last fire, counts, watchdog and any configured On fire tool calls. Some columns appear only when they have data; continuous dogs show firing counts, while one-shot dogs omit those counters.

**Recently Fired** keeps fired events and listener-watch threshold crossings. An event row names the firer and firing age; click its single-line message to expand it. Sub-rows show who received it, how long they had listened and a **fire mail** link. That link opens the receiving agent's Mail tab, not the project's mailbox. Deleted or archived mail is marked unavailable. Tinted watch rows show the watch owner, wait and armed/required count, followed by the listeners armed at that moment. Historical dog names remain after the dog is gone. Older fires load on scroll with Retry on failure.

For watchdog setup, exact event/readiness recipes and their limits, open `orgtree-tool-watchdog` (orgtree-working › watchdogs) or `orgtree-concurrency-primitives` (orgtree-workflows › collaboration-patterns).

## Dead letters

This tab holds ACK jobs that exhausted their attempts. They remain out of circulation until retried. Each row shows the sender, preview, attempt count, last holder, failure age and reason. **details** opens the body and attempt history. **retry** returns the job to the queue with attempts reset; **drop** closes it with a required reason. **show dropped** includes closed entries without making them eligible for delivery. Dead Letter Line in the Mail folder lists agents listening for these events; this tab lists the jobs.

## Remembered tabs and folders

Agent and project desks remember the last chosen tab per organization and node, across revisits and app restarts. A project's Mail tab also remembers the folder explicitly picked in its folder strip: inbox, sent or listeners. A folder opened by a header card does not replace that folder preference.

Memory is browser-local (`orgtree-desk-tabs:<org>`); when local storage cannot be written, a session-only copy is used. An already-open desk keeps its own selection when a pinned or popped-out copy changes tabs. If a saved or open tab is unavailable, a project desk selects Summary and stays there when the tab becomes available again. An agent desk uses Chat for that fallback.

## See also

- [orgtree-agent-desk](../agent-desk/SKILL.md)
- [orgtree-inbox-screens](../inbox-screens/SKILL.md)
- [orgtree-docket-screens](../docket-screens/SKILL.md)
- [orgtree-presentations](../presentations/SKILL.md)
- [orgtree-agents-list](../../canvas/agents-list/SKILL.md)
