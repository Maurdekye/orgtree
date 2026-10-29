# Projects, queues and automation

[Documentation](../README.md#documentation) · [Previous: Collaborating and Hubchat](collaborating.md) · [Next: Operating and troubleshooting](operating-orgtree.md)

A project groups agents without adding a model seat. Start with its Summary and team. Add a queue when similar jobs need workers, slots when work shares limited capacity, and events when participants need a signal. Watchdogs let agents wait for these and other observable conditions without spending a turn repeatedly checking them.

## Create a project and explain its purpose

Use a project token or **New project…** at the intended place in the tree. Name it and optionally write its **Summary**. A project can sit above or below other projects and agents. It has no model, effort, account or independent credit grant and takes no turns itself. Its agents still report to the nearest agent superior above the project.

Before creating it, use the draft card's **gear** to choose project settings: peer mail, queue mode and sender exclusion, concurrency slots, Project Events, and acknowledgement policy. **save** keeps those choices in the draft; **cancel** or Escape leaves the open settings edits unapplied. Create applies the saved settings together with the new project. A refused creation keeps the draft and its saved settings for correction and retry.

Select it to open the desk. Click the Summary to edit; leaving the editor saves a change and Escape discards it. The Summary is standing guidance for agents under the project. State the purpose, responsibilities and any agreement about slots, queues or releases there.

The desk's common tabs are Summary, Mail, Docket, Presented and, while it has live members, Team. Docket lists items owned by agents below it; the project is not itself an item owner. Presented shows documents attributed to the project; **Team presentations** adds its agents' documents. Settings controls project policies, and History appears when records exist.

Slots appears when capacity is positive, events while **Project events** is on, and Dead letters while open dead-letter jobs exist. A project's desk can be pinned or popped out like an agent desk, retaining its own selected tab and mail folder. The same views are one click from the canvas: on the project's near-zoom card, the slots badge opens Slots, a listeners badge opens events, and the queue badge opens events while a mail listener is armed (the project mailbox when none is).

## Choose mailbox delivery or broadcast

The project composer sends to the **project mailbox** by default. It does not automatically send the same message to every member. A mail-queue listener must take the job. If none is attached, the warning explains that messages may not be read. With the app's listener-wake setting on, the first such mail asks one direct agent member to arm a listener; mail still waits until a listener actually does so.

The **megaphone** switches to broadcast (Alt+B). It sends one copy to each live agent child, passing through live sub-projects and stopping at every agent recipient. An agent's own reports do not receive it, even if another project sits beneath that agent. For example, in Project → sub-project → Alice → Bob, Alice receives the broadcast and Bob does not. The agent broadcast tool follows the same rule. Use it for a direction the project participants need, rather than a job only one worker should own. Attachments, notices and applicable urgency follow the send. A broadcast does not establish that everyone read or completed it.

Deep nesting does not impose a fixed cutoff on broadcast membership, listener reach or queue ownership. The desktop sends to at most 1,000 eligible agents, nearest first. The agent broadcast tool reads recipients in 100-row pages through its initial ID boundary. Both keep ordinary per-recipient authority checks and outcomes. Projects remain transparent for reporting and credits through the complete chain; grouping agents does not remove an outer scope or funding boundary.

Project audiences and direct-member inheritance are covered in [Collaboration](collaborating.md#understand-who-can-message-whom). Sending to a project grants the project a user audience, rather than granting all broadcast recipients independently.

## Run a work queue

For repeated similar jobs, ask workers above/below the project to arm **fair-queue listeners** through their watchdog tools. Post one job per mail with the megaphone off. The engine hands each message to one eligible listener and keeps its original sender, files and identity.

Choose **Project settings > Mail queue**:

| Mode | Use and behavior |
| --- | --- |
| Round-robin | Spread independent jobs among listeners, least recently served first. Delivery records handout, with no completion acknowledgment required. Busy mailboxes can accumulate work. |
| ACK | Track completion. Each listener holds up to its batch size in outstanding jobs, then takes more as it acknowledges them. Jobs are handed out in queue order; parallel completion order can differ. |

Start with a batch of one. Larger batches (up to 20) suit small independent tasks but do not justify acknowledging before completion. In ACK mode an agent replies to the project with the handed job's exact reference and a completion record. Reading the project's original message, or the worker merely receiving it, is not that acknowledgment.

**Mail > listeners** separates Working, Line and Recently Finished in ACK mode, or Line and Recently Delivered in round-robin. Inspect the job, holder, wait/hold age, batch and watchdog. Paused/unavailable listeners differ from ready workers. **Dead Letter Line** lists notification subscribers, not failed jobs.

### Reclaim and retry deliberately

Timeout checkups rotate through all of an agent's held jobs and leases in
bounded pages, across projects. One due checkup processes up to 20 jobs and
20 whole leases; later checkups continue after that page. A holding with its
timeout disabled stays held and does not prevent later holdings from being
checked. These page sizes are processing bounds, not holding limits, and are
separate from a mail listener's batch size. Reclaim remains subject to each
project's configured reminder budget and current custody.

Project **Acknowledgement** settings include Ack timeout, Ack reminders, Max attempts and the mail-only turn-end reminder. With Runtime working checkups and timeout on, an inactive agent gets the configured reminder budget, then its job can return to the queue. These are eligibility-based checkups, not precise wall-clock deadlines. A turn-end reminder is a separate nudge after a consumed job and ordinary successful turn; it does not prove the task finished.

Reporting Blocked, Idle or Done does not by itself suppress these resource-custody checkups: an agent still holding unacknowledged project mail or a slot lease can remain eligible under the checkup setting. Inspect the actual holdings and release/acknowledge completed work rather than treating a status label as a release.

**Take back** reclaims an agent-held job after confirmation and prefers another listener for its next assignment. It tells the former holder to stop that assignment, but does not terminate its process or undo file writes. Coordinate work already in progress before another worker repeats it. Retries are not a promise of exactly-once external effects.

After the attempt limit is exhausted on a qualifying reclaim, the job moves to **Dead letters**. Details shows its body and attempt history. **Retry** resets attempts and returns it to the queue; **Drop** closes it with a reason. Show dropped includes history, without making it runnable. Resolve the last open entry and the tab disappears. The normal dead-letter notification reaches the nearest live agent superior, or the user if none; it does not notify every member automatically.

**Purge waiting mail** removes only pending, unassigned jobs. It leaves held, acknowledged and dead-letter records. Switching ACK to round-robin waives outstanding acknowledgment requirements, including user-held jobs, without manufacturing completion records. Switching into ACK does not retroactively require old round-robin deliveries to be acknowledged.

## Share limited capacity with slots

Set **Concurrency slots** in Project settings to the capacity the team has agreed to share. Zero disables new claims. A one-slot project can coordinate exclusive access to a shared resource; several slots can represent several concurrent tests or service uses.

Slots are **cooperative**. They count reservations, keep a queue and notify claimants. They do not reserve RAM, throttle arbitrary processes, enforce a sandbox or authorize otherwise forbidden work. Put the guarded operation and claim/release agreement in the Summary.

A claim can reserve several units together. All requested units become **one lease**, and the strict first-come line waits until the head fits in full. A smaller claim behind a larger head does not jump it. Release returns the entire lease; there is no partial release. Leases and waiting claims survive engine restarts.

The **Slots** tab separates Holding, Line and Recently Held. It shows the holder, wait/hold times, quantity, lease and claim watchdog. The lease identifies a reservation; it is not a numbered physical slot. A held-slot chip opens the project view. An immediate ready claim may create no persistent watchdog even though its lease is real and must be released.

Ask agents to claim before the guarded work and release immediately afterward, before unrelated reporting or waiting. A holder that cannot run gives its holdings back at once. Its slot leases, and the un-acked jobs of an ACK-mode queue, are released the moment it is frozen by a usage limit, halted, moved out of the project, or loses its turn to a crash, an idle or time-limit kill, or a provider or harness error. A manual interrupt, an agent ending its own turn and an engine restart do not release anything: a turn the restart cut keeps its leases and jobs and carries on afterward. The next waiter is granted in line order, and a released job returns to the front of the queue under the usual attempt and dead-letter rules. The former holder reads one notice at its next turn naming everything released, and Recently Held shows why (`frozen`, `halted`, `moved out of the project` or `turn ended abnormally`). An agent that moves out of a project also loses its waiting claim there and has its queue listener paused, not removed; moving back resumes nothing by itself. A holder that is merely idle still waits for the configured idle-reclaim checkups. **Force release** and **remove from line** are different actions, and neither stops a process. Inspect the actual resource state before giving another worker access.

Retiring an agent releases all its leases across every project, including whole multi-slot holds, and removes its active waiting claims. Dissolve/delete clean up affected descendants too. After commit, each affected first-come line is checked for complete grants; recent history records the retirement ending. User-owned holds remain held. Automatic bookkeeping does not prove the former holder's protected process stopped.

### Hold slots yourself

Use **Hold 1 slot / Hold N slots** in the tab header. Your request shares the same first-come line and reserves the whole quantity. Use **release** on a held row or **cancel request** in Line. Multiple holds/waits remain bounded by project capacity.

Your holds persist until **you** release them, including across engine restarts. Agent tools cannot release them, and no idle timeout takes them back. Remember the lease when leaving the app or blocking a worker's head claim.

## Signal a group with events

Turn on **Project events** in settings to expose events. Agents registering event listeners or listener watches can also enable it. An event is a signal to the listeners armed **when it fires**; it is not replayed to someone who registers later.

Use the optional message and **fire event** to notify listeners. A one-time listener spends itself on the next fire; a continuous listener hears later fires too. **Listener watches** wait for an armed-listener count, useful when a coordinator should know that a group is ready. A watch can be paired with an authorized on-fire action to release that group. Counted readiness does not prove the group completed a task.

The engine records the event and its captured subscriptions, then delivers in bounded committed pages and resumes unfinished dispatch. It is not one atomic transaction across all listeners, and recipients need not begin work simultaneously. Keep durable task state in a file or docket item rather than relying only on a signal body.

The tab shows Event listeners, Listener watches and Recently Fired. Fire history names the firer, message and recipients, with links to their delivered mail. Turning events off pauses the project's active marked listeners/watches and hides the tab; turning it back on restores those, without rearming registrations their owners paused manually. It does not recreate a spent one-shot.

### Register yourself

In events, **Register…** offers a one-time listener, continuous listener or watcher for N armed listeners. You keep one listener and one watch per project; switching mode or count updates the same registration. A watch already at its count can fire immediately. Use remove on your row when finished. The watch range is 1–1,024.

Your event/watch notifications arrive as normal Inbox mail without running an agent turn. The eye card's project lines and watchdog chips show your participation. A chip navigates to its project.

## Join the mail queue yourself

In project Mail choose a batch (1–20) and **Join mail queue**. You take a normal place in the round-robin. Changing your batch keeps that place and existing jobs; raising it can hand out waiting work immediately, while lowering it takes nothing back.

ACK jobs arrive in your Inbox with a project-job pane. Choose **Reply & acknowledge** to send a reply and finish the assignment, or **Acknowledge without reply**. For a self-sent job there is no correspondent to reply to, so use **Acknowledge job**. Reading, closing or deleting is not an acknowledgment.

Use **leave queue** on your Line or Working row in Mail > listeners. Leaving removes the listener but **keeps jobs you already hold**. Only you can acknowledge those jobs: no timeout or take-back reclaims them. Changing the queue to round-robin is the separate ACK-waiver exception described above.

## Ask agents to wait with watchdogs

A watchdog is a persistent monitor, not an agent seat. Ask an authorized agent for a specific observable condition and the action/message wanted when it happens. It can end its turn while the engine watches. A one-shot is useful for a deadline/completion; a continuous watch suits repeated events.

| Kind | Typical use and important distinction |
| --- | --- |
| File | New appended log lines; existing content is not replayed at creation. |
| Command | A safe repeatable probe whose output matches a condition. It runs during creation too; it is not merely stored text. |
| Process | An observed process/port transition from up to down, with unknown probes kept distinct from death. |
| Stream | A long-lived command's new output. Resume after exit starts it again; missed offline output is not reconstructed. |
| Activity / engine event | Permitted turn/tool or structured engine transitions, including count thresholds. |
| Usage | Cached allowance edges/reset/freshness, without a new provider request for each watch. Unknown is never zero. |
| Project queue / slot / event / listener watch | The shared primitives above. |
| MQTT / WebSocket | Network messages on a maintained connection, with optional filters, authentication and heartbeat/hello settings where supported. |
| App event | A declared event fired by an app's saved panel: one panel, or every panel of the app. |

Agent tools create most general watches; the human UI supplies the project registrations described here and watchdog inspection/control. There is no generic “create any watchdog” form. A ready one-shot command/process/usage/slot/queue claim can resolve immediately in the agent's tool result with no later watchdog mail. The agent must read that result rather than wait for a notification that will not come.

Save as template can include standing watcher definitions and explicit audiences. Inspect its preview and warning counts; portable watchers can arm and wake agents after import, while machine-specific, saved-paused or credential-dependent watchers remain paused. No output history or held leases migrate. See [reusable layouts](workspace.md#reuse-a-layout) before creating an org from that template.

## Inspect and maintain a watch

Open its chip on the canvas or desk. The detail shows owner, kind, target, match/filter, cadence or quiet period, state, last check/fire and retained event summaries. More than eight watches fold into a paged list. **Armed**, **paused**, **exited/error** and a departing one-shot are distinct states. Closing the panel does not stop monitoring; use Pause, Resume or Remove.

An app event watch shows ▦ on its chip. Its tooltip and detail name the app, the panel (or all panels) and the event, current names first with their IDs after them. A deleted app or panel is shown as deleted, and the watch is paused with the reason.

For MQTT/WebSocket, **Connection messages** chooses passive Notice (default), Wake or Off. That changes outage/recovery administrative mail without reconnecting or replaying hello. Incoming server data keeps its own filtering and wake rules. Agents can send through their owned live connection; that action requires their actual authority and does not dial an unrelated client.

Network payloads are untrusted data, not instructions or user authorization. A watchdog also adds no file/tool permissions. On-fire tool actions run as the owner at fire time and can be refused if its scope changed. A fire proves the configured observation/notification, not that the owner completed follow-up work. Give failures, retries and resource cleanup an explicit owner.

An ordinary fire projected into an agent's turn can show only 20 matching lines of up to 500 Unicode characters each. More context can remain in the retained fire mail or original authorized source; the brief turn display and watchdog list are not full-output archives. Network payloads and on-fire results have their own bounds.

The final reader guide covers [Operating and troubleshooting](operating-orgtree.md).
