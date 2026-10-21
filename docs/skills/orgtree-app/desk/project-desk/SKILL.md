---
name: orgtree-project-desk
description: Explain project desk tabs, mail workers and history, slots, event listeners, dead letters and remembered navigation.
---
Up: [orgtree-desk](../SKILL.md)

# Project desk

Select a project on the canvas to focus its desk. **Open > Desk** opens its modal; the desk can also be pinned or popped out. These surfaces share the same project views. A project has a mailbox and team but runs no conversation or turns itself.

Opening a desk that is already visible refocuses or reveals that existing desk,
as for an agent. A stationary click on its canvas background recenters it;
dragging still pans. Pinned desks are raised and revealed, popped-out windows
are activated, and an open modal keeps its tab and message draft. Reopening
does not create another desk or reset its navigation.

With **Restore previous windows** enabled, a saved project desk pin or pop-out
reopens for the same project generation. A replaced or missing project is
skipped with the saved-window availability warning. Older 4.4 alpha desk records
without a generation reopen only while the same id is a live project; the next
save records its generation.

With **show agent card shortcuts** on, the project card's hover row opens its docket, mail, presented, team and slots windows, and its desk on the listeners tab. Team, slots and listeners appear only while the desk offers those tabs (see the table below). The row hides while the desk is open on the canvas or its pinned placeholder holds the card.

The header shows active/hired agents through nested projects, activity age, settings and the available team lifecycle controls. Header cards open the mail queue, event listeners or slots; held audiences appear alongside them. Superior jump cards stay below the header, and member jump cards above the composer, on every tab. Project jump cards show the same spinning arrows as agent jump cards whenever any live agent below the destination project is mid-turn, at any depth; they stop when all are idle. The composer sends to the project mailbox by default; its megaphone broadcasts to live agents under the project. Notice, attachments and reply previews work as on an agent desk. Projects have no model, effort, account or credit controls.

When broadcast is off and no mail listener is attached, a compact warning above the message box says "Messages sent here may not be read by anyone". Turn on **broadcast** with the megaphone (Alt+B) to send to all project participants. The warning disappears while broadcast is on or an armed or paused `fair_queue` mail listener is attached. Event listeners do not receive inbox mail and do not dismiss this warning. It uses the same warning line as the agent desk's cheap-compaction warning.

## Tabs

| Tab | Contents and availability |
| --- | --- |
| summary | Project Summary: Markdown when unfocused, editable text when clicked. Leaving the editor saves a change; Escape discards the edit. Retired projects show it read-only. |
| mail | Project inbox, sent and listeners folders. Reading a project message does not claim or acknowledge its queue job. The separate project Mail window uses the same view. |
| docket | Items owned by agents under this project, through nested projects. A project owns no items itself. |
| presented | Only documents attributed to this project. The canvas card's document chips and desk-header chips show the same own-only scope (up to four recent documents). Descendant documents are available through Open → Presentations → Team presentations; unlike an agent gallery, the project tab has no Team checkbox. |
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

**take back** is available to the user and project ancestors. It puts a held job at the front of the queue, preferring a different listener for its next assignment and falling back to the same one. If the job has exhausted its attempts with Runtime working checkups enabled, it goes to dead letters instead, even when project Ack timeout is off. The former holder is told to stop and cannot acknowledge that reclaimed assignment. This does not terminate its process: coordinate any work already in progress before another worker repeats it.

## Project settings: Acknowledgement

This section appears in ACK mail-queue mode or when the project has concurrency slots. **Ack timeout** and **Ack reminders** apply to both un-acked mail jobs and idle slot leases. With Runtime working checkups and Ack timeout on, the holder gets the configured number of 20-minute checkup reminders (1–10, default 3); the next checkup reclaims the mail or releases the whole slot lease, including every slot in it, and checks the waiting line.

**Max attempts** is mail-only: a reclaimed job that has exhausted its hand-outs goes to dead letters. It does not limit slot claims. The immediate **turn-end reminder** is also mail-only; slot leases use the working-checkup reminders. Turning off working checkups makes the checkup-based controls inactive. Max-attempt enforcement on other reclaim/take-back paths also needs working checkups, but does not require project Ack timeout. The immediate turn-end nudge is independent of both switches and does not consume the checkup reminder budget: it requires the agent to have consumed the handed copy and finished an ordinary successful turn. A fresh blocked status with a nonempty reason suppresses that nudge.

## Slots

Capacity is configured in Project settings, from 0 (disabled) to 9,999,999. Multiple whole leases may be held by the same agent or user, within their remaining room; a lease's Slots quantity is not a count of separate claim watchdogs. Holding and Line initially show up to 100 rows each; their Show more controls reveal further rows. Holder chips aggregate quantities by project.

One table separates **Holding**, **Line** and **Recently Held**. Columns include Position, Agent, Waited, Held, Ended, **Lease**, Slots, **Watchdog** and Action. Lease identifies the reservation; Slots is its quantity, which may exceed one. A grant reserves the whole quantity together. The Watchdog column names the claim dog, including its retained identity after a one-shot claim has been spent.

Holding shows current reservations and offers **force release** with confirmation. Line shows queued claims and **remove from line**. **Hold 1 slot** / **Hold N slots**, in the tab's header row left of the pin, pop-out and modal buttons while the project is live, holds slots for the user themselves at once; see *The user's own slots, listeners and queue place* below. Recently Held shows ended leases, their wait and hold durations, ending age and dog. Ordinary releases have no extra ending label; unusual endings show labels such as forced or timed out. Scroll to load older holds, or Retry after a read failure.

Force release returns all units in that lease and checks the FIFO line; the head must fit in full. Removing a queued claim does not release a held lease. Neither action stops a holder's process. Use the project's current agreement for resource policy and recovery. Agent tool permissions and lease visibility differ from this user desk; see `orgtree-tool-project` (orgtree-working › team).

## Listeners: project events and Recently Fired

The tab has the pin, pop-out and modal buttons the other tabs have, with **Register…** to their left (see below); the modal is the project's listeners window, which **Open › Listeners** in its menu and the card's Listeners shortcut open too. The **fire event** control sends its optional message to currently armed project-event listeners. It does not deliver old events to listeners that register later. While the project's event listeners are off, the tab is hidden and the event cannot be fired. Switching them off disables every event listener and listener watch on the project: each stops listening, loses its canvas line, shows a dimmer ⊘ chip whose tooltip and detail say why, and its owner is told; switching them on again re-arms those dogs, not ones their owners paused. **Event listeners** lists `project_listener` dogs; **Listener watches** lists dogs waiting for a specified armed-listener count. The table shows wait age, last fire, counts, watchdog and any configured On fire tool calls. Some columns appear only when they have data; continuous dogs show firing counts, while one-shot dogs omit those counters.

**Recently Fired** keeps fired events and listener-watch threshold crossings. An event row names the firer and firing age; click its single-line message to expand it. Sub-rows show who received it, how long they had listened and a **fire mail** link. That link opens the receiving agent's Mail tab, or the user's Inbox for a user listener, never the project's mailbox. Deleted or archived mail is marked unavailable. Tinted watch rows show the watch owner, wait and armed/required count, followed by the listeners armed at that moment. Historical dog names remain after the dog is gone. Older fires load on scroll with Retry on failure.

For watchdog setup, exact event/readiness recipes and their limits, open `orgtree-tool-watchdog` (orgtree-working › watchdogs) or `orgtree-concurrency-primitives` (orgtree-workflows › collaboration-patterns).

## The user's own slots, listeners and queue place

In a popped-out desk or Listeners window, Register… keeps its panel open while
you use its count input or scroll inside it. Choosing a registration closes the
panel; pressing Register… again, clicking or scrolling outside, or pressing
Escape also closes it.

The user can take part in a project's concurrency primitives themselves, from three tabs. Slots and Mail use a number beside a button whose words follow it; Listeners uses the three-row Register… menu. They sit left of the tab's pin, pop-out and modal controls. Pressing an action applies it immediately without a confirmation dialog; the help text is in the tooltips. Each sends one desk operation; there is no tool or Hubchat equivalent (agents cannot make or end these). The engine names the user **user** (a reserved word no agent can have) and the desk draws it everywhere as the standard **@user** mention chip, the same chip an @user mention gets in prose: it opens the user's inbox, and is inert where a surface cannot open it. Agents see these entries too, named `user`, in `orgtree_project action=slots` and `action=listeners`.

| Where | Control | What it does |
| --- | --- | --- |
| Slots | **Hold 1 slot** / **Hold N slots** (a number beside it, default 1) | Asks for N slots at once. N runs from 1 to the project's count less the slots the user already holds or waits for (a waiting request counts), and the button is grey when none is left. The request waits **first come first served** in the same line as the agents' claims and is granted **whole** when all N are free together; a smaller claim never jumps a larger head. A hold counts against the capacity like an agent's lease and **lasts until the user releases it**, across an engine restart too: nothing reclaims it (no halt, retire or idle checkup applies to the user). The user's holds and waiting requests together stay within the project's slot count. A Holding row has a plain **release** (no confirmation, not "forced"); a Line row has **cancel request**, which also grants the claims behind a blocking head. |
| Listeners | **Register…**, a panel of three rows | **Register one time event listener** hears only the next event fired on the project (then it removes itself); **Register continuous event listener** hears every event; **Register watcher for N listeners** (a number beside it, default 1, range 1–1,024) is a one-time notification when the project's armed event listeners (the user's own included) reach N; already there, it fires at once. The user keeps one listener and one watch per project, and registering again changes them in place: the registered kind's row is grey and the other reads **Switch to continuous event listener** (or **Switch to one-time event listener**), switching the same listener; the watch's row is grey until the number differs, then reads **Watch for N listeners** and updates the same watch's count. **Register…** is enabled while any row is. Registering switches the project's event listeners on, as an agent's does; switching them off pauses the user's registrations like everyone's, and switching them on restores them. Their rows have **remove**. The tab itself still exists only while the setting is on, so the first registration starts from the project settings toggle. |
| Mail (every folder) | **Join mail queue** / **Join mail queue twice** / **Join mail queue N times** (a number beside it, the batch), **leave queue** | Joins the queue at once as a listener with a batch of 1 to 20 (the engine's limit, shared with the agents' queue dogs) and takes its turn in the round-robin like any listener. In ACK mode the user holds up to their batch of jobs. In the queue already, the number shows the batch and the button is grey until it differs; pressing it then changes the batch in place: the place in the order and any held job are kept, a raised batch hands a waiting job at once, a lowered one reclaims nothing. The control ends the folder strip, after **Purge waiting mail** (while mail waits); **leave queue** is in the listeners folder. **leave queue** removes the listener; **a job already held stays held until it is acknowledged**, and nothing reclaims or takes it back. |

**Queue-mode exception:** switching from ACK to round-robin waives all outstanding acknowledgements, including the user's held jobs; leaving the queue alone keeps those jobs held.

**Leaving the mail queue.** Use **leave queue** on the user's own Line or Working row in the listeners folder. There is no separate top leave button. A full ACK batch has no Line row, so its Working rows keep the leave action beside **open mail** while the user remains joined. These are compact icon buttons on one row, with their words and help in tooltips and accessible labels. Leaving removes only the listener; held jobs remain until acknowledged.

**Self-sent jobs.** If the user sent the job themselves, there is nobody to reply to. The pane explains this and offers **Acknowledge job**, without a reply composer or attachments. No mail is sent and no completion text is saved: the ACK API records a sent reply's ID, not a free-text note. Jobs from agents or external senders keep **reply & acknowledge** and **Acknowledge without reply** as below.

**Where it arrives.** An event listener's fire, a watch's notification and a queued job reach the user as **normal mail in their inbox** (a fire arrives as a watchdog mail with its event card). In ACK mode a job shows a *project job* tag in the reading pane and an acknowledge pane in place of the reply box: the ordinary reply composer (notice and attach buttons included) whose send button reads **reply & acknowledge** (it needs a reply, which goes to the job's sender as an ordinary reply, then acknowledges) and, under it, **Acknowledge without reply**. Reading a job never acknowledges it. Acknowledging ends the attempt as acked, frees the user's place, and the queue hands the next waiting job at once; a round-robin job needs no acknowledgement. A Working row for the user's job offers **open mail** (the user's copy, in their inbox) where an agent's has **take back**; the engine refuses to take a job back from the user. The user's holds, listeners, watches and queue place are drawn on the canvas from the **eye (switchboard) card** to the project, with the same coloured lines an agent gets (amber slot line, solid for a hold and dashed for a wait; cyan listener line, dashed for a watch; the fair-queue line), and their watchdogs hang below the eye card as chips (a chip takes you to its project); they also count in every card and count.

## Dead letters

This tab holds ACK jobs reclaimed after exhausting Max attempts (1–100, default 3) while Runtime working checkups is on. A final hand-out alone does not dead-letter a job. They remain out of circulation until retried. Each row shows the sender, preview, attempt count, last holder, failure age and reason. **details** opens the body and attempt history. **retry** returns the job to the queue with attempts reset; **drop** closes it with a required reason. **show dropped** includes closed entries without making them eligible for delivery. Dead Letter Line in Mail > listeners is a separate preview of up to 200 matching armed/paused event watchdogs for project.dead_letter or project.*. Paused rows receive no fires; a payload-specific filter may not match the preview's empty job details. This tab lists jobs instead. Resolving the last open dead letter hides the tab; retained dropped history is still available to an authorized agent through orgtree_project action=dead_letters include_dropped=true. Dropped letters cannot be retried directly.

The automatic system notification goes through intervening projects to the first real-agent ancestor if live, otherwise the user. It does not notify every member or the original sender. Agents can separately subscribe to the event; subscription does not assign responsibility for resolving it. Purge waiting mail does not remove dead letters. For the full agent contract, see orgtree-tool-project (orgtree-working > team).

## Remembered tabs and folders

Agent and project desks remember the last chosen tab per organization and node, across revisits and app restarts. A project's Mail tab also remembers the folder explicitly picked in its folder strip: inbox, sent or listeners. A folder opened by a header card does not replace that folder preference.

Memory is browser-local (`orgtree-desk-tabs:<org>`); when local storage cannot be written, a session-only copy is used. An already-open desk keeps its own selection when a pinned or popped-out copy changes tabs. If a saved or open tab is unavailable, a project desk selects Summary and stays there when the tab becomes available again. An agent desk uses Chat for that fallback.

## See also

- [orgtree-agent-desk](../agent-desk/SKILL.md)
- [orgtree-inbox-screens](../inbox-screens/SKILL.md)
- [orgtree-docket-screens](../docket-screens/SKILL.md)
- [orgtree-presentations](../presentations/SKILL.md)
- [orgtree-agents-list](../../canvas/agents-list/SKILL.md)
