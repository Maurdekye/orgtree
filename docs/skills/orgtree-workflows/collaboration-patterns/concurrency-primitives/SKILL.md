---
name: orgtree-concurrency-primitives
description: Choose and compose project locks, semaphores, work queues, signals, latches, readiness monitors and barriers, with exact calls and limits.
---

Up: [orgtree-collaboration-patterns](../SKILL.md)

# Coordinate work through projects

Choose the agreement first, then its primitive. These are cooperative protocols: Orgtree records grants, queues and events, but does not prevent unclaimed work, stop a process on lease loss, or verify that an acknowledgement means success. Reading a recipe grants no authority to create projects, move a team, change settings or start work.

| Need | Use | Important limit |
| --- | --- | --- |
| One agent using a resource | One-slot mutex | One claim/hold per agent per project; no reentrant acquisition. |
| Up to N concurrent users | N-slot counting semaphore | Counts holders, not threads, memory or calls per second. |
| Independent jobs spread across workers | Round-robin mail queue | Least recently handed work; not a health or idle-worker check. |
| Jobs with completion records and retry | ACK FIFO work queue | Handout order, not completion order or exactly-once effects. |
| Tell current subscribers something happened | Project event | No replay to a listener that arms after the fire. |
| Wait once for a release | One-shot event listener | A one-shot wait, not a sticky latch for late arrivals. |
| Know N participants have registered readiness | Listener watch | Counts armed listeners, not a verified participant roster. |
| Release a ready group | Listener watch with a fire-event action | A cooperative barrier; mail delivery does not synchronize execution. |
| Independent resources or topics | One project per resource/topic | Every participant must reach every project it uses. |

## Setup, reach and call notation

For each recipe, an authorized supervisor first places the existing worker team below the named project. Only agents above or below a project reach its slots, queue or event; peers beside it cannot subscribe. A directional audience does not replace this tree relationship. For example, the supervisor may insert @resource-lock above its existing agent @workers (whose team stays underneath), then set its slot count:

```json
[
  {"tool":"orgtree_project","args":{"action":"create","name":"resource-lock","above":"workers","description":"Claim before accessing the shared resource; release immediately afterwards."}},
  {"tool":"orgtree_project","args":{"action":"configure","name":"resource-lock","settings":{"slots":1}}}
]
```

Blocks show separate tool calls as `{tool,args}` records, in order; pass only `args` to the named tool. Substitute actual project names and returned IDs. Creating above uses the anchor's position and needs no index; ordinary creation instead requires an explicit index. Setup needs the team tools and normal placement authority. Claim/listener recipes need watchdogs; verify that the current CLI also exposes the required project actions before starting. Tool switches, reach and messaging authority still apply. See `orgtree-tool-project` (orgtree-working > team), `orgtree-tool-watchdog` (orgtree-working > watchdogs), and `orgtree-tool-message` (orgtree-working > mail) for complete contracts.

## Mutex, semaphore and lease recovery

A worker claims @resource-lock before the protected work:

```json
{"tool":"orgtree_watchdog","args":{"action":"create","kind":"slot","target":"resource-lock","name":"edit-resource","once":true}}
```

If granted immediately, use the returned lease. If queued, end the turn; the one-shot dog wakes you with the lease when granted. Never infer a grant from queue position or from the dog disappearing. Do the agreed work only while holding the grant; release immediately when finished, including error cleanup, before reports or unrelated waits:

```json
{"tool":"orgtree_project","args":{"action":"release_slot","lease":"<returned-lease>","note":"Resource update finished"}}
```

For a counting semaphore, the supervisor configures `{"action":"configure","name":"resource-lock","settings":{"slots":3}}` instead; each worker uses the identical claim/release protocol for one permit. Three is an example capacity, not permission for three builds on any machine. Capacity 0 disables claims. Slots allocate permits in arrival order among eligible claims; they have no priority setting. Resource/RAM gates and process containment are separate agreements; [build-slots](../build-slots/SKILL.md) applies these ideas to builds.

Inspect state or recover a stuck agreement with these distinct calls:

```json
[
  {"tool":"orgtree_project","args":{"action":"slots","name":"resource-lock"}},
  {"tool":"orgtree_watchdog","args":{"action":"remove","id":"<my-waiting-dog-id>"}},
  {"tool":"orgtree_project","args":{"action":"release_slot","lease":"<stuck-lease>","force":true,"note":"Holder confirmed stopped"}},
  {"tool":"orgtree_project","args":{"action":"unqueue_slot","name":"resource-lock","agent":"waiting-worker"}}
]
```

These are alternatives, not a cleanup sequence: anyone reaching the project can inspect; a worker removes its own waiting dog; only the user or a project ancestor force-releases another holder or removes another agent from the line (team permission required). Ordinary status hides other holders' lease IDs. Pausing a waiting dog also leaves the line; resuming rejoins at the back. A granted dog's one-shot removal does **not** release its lease; use `release_slot`. Halting/retiring a holder reclaims its permit. Idle reclaim needs Runtime's working checkups and the project's ack timeout, with its configured reminder budget; leases/claims survive restarts. A forced/reclaimed permit does not kill the old holder's process: stop or otherwise confirm its protected work has ended before letting a replacement touch the resource. This is not a fencing-token lock.

## Load balancer and FIFO work queue

Assume the supervisor has placed workers below @jobs. For quick independent work, select round-robin, have each worker arm a persistent queue listener, then post one job per mail:

```json
[
  {"tool":"orgtree_project","args":{"action":"configure","name":"jobs","settings":{"mail_queue":"round_robin"}}},
  {"tool":"orgtree_watchdog","args":{"action":"create","kind":"fair_queue","target":"jobs","name":"take-jobs","once":false}},
  {"tool":"orgtree_message","args":{"metadata":{"to":"jobs"},"body":"Job sample-17: produce the agreed result."}}
]
```

Configure is the supervisor's call; each worker makes its own watchdog call; the authorized producer sends the mail. A project post is handed to exactly one listener, least recently woken/handed work (never fired first, then oldest watcher). Round-robin does not wait for completion and may pile work onto a busy, halted or frozen worker's mailbox. It is a load balancer, not a worker-health scheduler. Mail waits when no eligible listener can take it; reading the project inbox does not claim it.

For a FIFO work queue with completion records, configure ACK mode **before posting**; workers keep the same persistent listeners:

```json
[
  {"tool":"orgtree_project","args":{"action":"configure","name":"jobs","settings":{"mail_queue":"ack","ack_timeout":true,"ack_reminders":3,"max_attempts":3,"turn_end_reminder":true}}},
  {"tool":"orgtree_message","args":{"metadata":{"to":"jobs","reply_to":"<handed-worker-copy-mail-id>"},"body":"Completed sample-17; result and verification are recorded at the agreed location."}}
]
```

Only the worker actually handed that mail sends the second call, after doing the work. Use the ID from its handed mail wrapper, not an unrelated project/history ID. Each agent holds at most one unacked job per project; acking admits its next job. FIFO is pending eligible mail's handout order; parallel workers may finish out of order, and retries return to the front. The queue does not validate the result. Halt/retire or stopping the listener releases an unacked job; pausing/removing the dog is not an acknowledgement. Work can execute twice after reclaim or a failed acknowledgement: use a job ID and durable checkpoints, and inspect prior effects before retrying.

With working checkups and ack timeout enabled, unacked jobs receive the configured reminder budget, then reclaim; exhausted attempts become dead letters. These are eligibility-based checkups, not a precise wall-clock timeout. A turn-end reminder is a separate nudge, not an ack or a forced successful completion. [work-queues](../work-queues/SKILL.md) owns those settings and delivery details. Diagnose and resolve a failed job separately:

```json
[
  {"tool":"orgtree_watchdog","args":{"action":"create","kind":"event","target":"project.dead_letter","name":"job-failures","once":false}},
  {"tool":"orgtree_project","args":{"action":"dead_letters","name":"jobs"}},
  {"tool":"orgtree_project","args":{"action":"dead_letters","name":"jobs","id":"<dead-mail-id>"}},
  {"tool":"orgtree_project","args":{"action":"retry_dead_letter","name":"jobs","id":"<dead-mail-id>"}},
  {"tool":"orgtree_project","args":{"action":"drop_dead_letter","name":"jobs","id":"<dead-mail-id>","reason":"Superseded; no further execution wanted"}}
]
```

The event watcher sees permitted dead-letter events (possibly from other reachable projects). Inspect the record and attempt history, fix the cause, then choose **retry or drop**, not both. Retry resets attempts while retaining history; drop requires a reason. These actions do not undo previous effects. Use only an authorized resolution.

## Broadcast, signal and a one-shot latch

For a signal on @phase-gate, each participant first subscribes; an authorized coordinator fires after registration:

```json
[
  {"tool":"orgtree_watchdog","args":{"action":"create","kind":"project_listener","target":"phase-gate","name":"phase-signals","once":false}},
  {"tool":"orgtree_project","args":{"action":"fire_event","name":"phase-gate","body":"Input version 7 is ready; read the agreed record."}}
]
```

The fire records mail for every currently armed live listener that still reaches the project in one delivery transaction, then schedules wakes. This is fan-out to subscribers; agents do not begin executing simultaneously. `notice:true` on a listener makes its delivery passive. A listener receives every fire on that project: it has no pattern/silence filter. A fire before subscription is lost to that future subscriber; durable application state belongs in a file or docket item, not solely in the signal body.

For a **one-shot latch-like wait**, change the participant's creation call to `{"action":"create","kind":"project_listener","target":"phase-gate","name":"wait-for-release","once":true}`. Arm it, end the turn and await the release event. It fires once and removes itself. This is **not a sticky latch**: a late arrival will not learn that release already happened. Either finish registration before firing (the barrier below), or agree that the producer publishes a durable released/version record before firing, and that participants check it after arming, so a fire racing that check is also observable. This extra protocol needs its own recovery if the producer stops before firing; the event alone supplies no sticky state. If the record already says released, remove any still-waiting dog with `orgtree_watchdog` args `{"action":"remove","id":"<returned-wait-dog-id>"}` and continue under that agreed protocol. A dog already spent by the same fire needs no removal; process that version once. Repeated rounds need a fresh protocol/version or a dedicated new project; an old signal is not a new-round acknowledgement.

To announce to every live descendant of a project rather than only its subscribers, use `{"tool":"orgtree_project","args":{"action":"broadcast","name":"phase-gate","body":"Announcement: the next phase uses input version 7."}}`. Broadcast requires team and messaging tools and is ordinary per-recipient mail, including nested descendants, with normal audience/peer-mail checks and per-recipient failures; inspect every outcome. It is not queued work and not proof that every participant read or accepted the announcement. Choose broadcast for announcements; event listeners for registered signal consumers.

## Readiness monitor and barrier

On a dedicated @round-gate, each of three intended workers arms a **one-shot project listener only after becoming ready**. The coordinator may watch before or after they arrive:

```json
{"tool":"orgtree_watchdog","args":{"action":"create","kind":"listener_watch","target":"round-gate","name":"ready-three","count":3,"once":true}}
```

This readiness monitor fires immediately if the armed count is already at least 3, otherwise when the count rises from below 3 to at least 3. It reports readiness but does not release the workers. `orgtree_project` with `{"action":"listeners","name":"round-gate"}` lists the actual listeners and watches; check them against the intended roster and current tree. Paused/spent listeners do not count; your own armed listener does. The count does not revalidate each live owner's reach after a move; event delivery does. Count is registrations, not proof that the agents remain runnable or that their work is correct. A continuous watch (`once:false`) fires again only after the count falls below and crosses again; it is not a repeating alarm while the count stays high.

For an automatic **barrier**, use this watch **instead of** the monitor-only watch (one watch per agent per project):

```json
{"tool":"orgtree_watchdog","args":{"action":"create","kind":"listener_watch","target":"round-gate","name":"release-three","count":3,"once":true,"fire_actions":[{"tool":"orgtree_project","args":{"action":"fire_event","name":"round-gate","body":"Round 7: all three registered; proceed."}}]}}
```

Each participant's ready call is `{"tool":"orgtree_watchdog","args":{"action":"create","kind":"project_listener","target":"round-gate","name":"ready-round-7","once":true}}`. It may trigger the barrier immediately inside creation; check both the tool result and queued fire mail. One coordinator watch releases the registered group; its own fire mail reports the action's outcome. Actions use that owner's **current** authority at fire time, not the authority it had at creation. A refused/timed-out fire action can leave ready workers waiting: inspect the reported failure and repair/release deliberately. Actions run after the watch fire is recorded; they are not one atomic watch-and-release transaction. They are bounded to four calls, 30 seconds each and chain depth four; they do not run under safe-start rehearsal and are unavailable on fair-queue dogs.

Use a dedicated gate/round and agreed roster: unrelated or continuous listeners also contribute to the count, so reusing a busy signal topic as a barrier can release early. The threshold is at least N, not exactly N. One-shot participants are spent by release; for another round explicitly re-arm after readiness and arm a fresh watch, ensuring no old registrations remain. For overlapping rounds use separate projects/versioned records. Tool limits also apply: one event listener and one listener watch per agent/project, eight kept watchdogs per agent and 32 per org at this source revision; the count range 1–1024 does not reserve that capacity.

## Per-resource locks and topics

Give each independent resource its own one-slot project; claim only the resource needed, so a database edit need not block unrelated file generation. For two resources used by the same worker team, the supervisor sets up:

```json
[
  {"tool":"orgtree_project","args":{"action":"create","name":"database-lock","above":"workers"}},
  {"tool":"orgtree_project","args":{"action":"configure","name":"database-lock","settings":{"slots":1}}},
  {"tool":"orgtree_project","args":{"action":"create","name":"artifact-lock","above":"workers"}},
  {"tool":"orgtree_project","args":{"action":"configure","name":"artifact-lock","settings":{"slots":1}}}
]
```

The chain becomes @database-lock > @artifact-lock > @workers, so every worker below @workers reaches both. Workers use the mutex claim/release calls above with the needed resource's project name. Sibling projects beside them would not give them reach. If work needs both resources, agree on one total acquisition order for every participant and release in reverse order; otherwise the team can deadlock. Prefer one combined resource agreement when partial acquisition cannot be made safe.

For topics, use one project per topic with the same reach arrangement. The supervisor creates @input-ready and @release-notes; a participant subscribes and the publisher fires on the chosen topic:

```json
[
  {"tool":"orgtree_project","args":{"action":"create","name":"input-ready","above":"workers"}},
  {"tool":"orgtree_project","args":{"action":"create","name":"release-notes","above":"workers"}},
  {"tool":"orgtree_watchdog","args":{"action":"create","kind":"project_listener","target":"input-ready","name":"new-input","once":false}},
  {"tool":"orgtree_project","args":{"action":"fire_event","name":"input-ready","body":"Input version 8 is available."}}
]
```

Repeat the last two calls with the watchdog target and fire_event name set to the other topic when needed. Project listeners cannot select messages by regex; project identity is the subscription boundary. If topic messages are jobs for **one** consumer, use that project's fair queue instead of events. Projects and slots do not add access to unrelated orgs or resources.

## Boundaries: what is not provided

- **Cooperation, not enforcement:** leases do not sandbox/throttle/stop work, grant folder access or reserve RAM. Automatic reclaim/forced release can overlap an old process unless the team stops it. A semaphore is not a rate limiter.
- **Arrival order, no priority:** eligible slot claims and queued mail have their documented ordering; there is no priority-queue setting or preemption. A supervisor's emergency procedure is an external agreement, not a scheduler feature.
- **No read/write lock:** use the one-slot mutex for all readers and writers when exclusion is needed; an N-slot semaphore does not distinguish readers from writers or safely support upgrades.
- **No shared atomic variable:** keep state in an agreed scoped file under a single-writer/slot protocol, or a docket record with `expected_rev` on updates. Read the current revision; on conflict re-read and reconcile rather than overwrite. Files are not inherently atomic and `expected_rev` is not a general compare-and-swap tool for external effects. See `orgtree-tool-work` (orgtree-working > docket).
- **No deadlock detection or atomic multi-project acquire:** use a common resource order, bounded work, explicit cancellation/lease cleanup and supervisor recovery. Check the current lease after reclaim/restart; never continue protected work on an ended lease.

These recipes document existing features only. Source checked at `becc495`: `tools/{defs,treetools}.rs`, `domain/{slots,projects,listeners,ops,docket}.rs` and `runtime/watchdogs.rs` in the Rust engine. Full tool mechanics remain in their named working-glossary pages.
