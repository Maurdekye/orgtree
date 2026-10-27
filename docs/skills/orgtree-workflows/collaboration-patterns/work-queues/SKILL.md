---
name: orgtree-work-queues
description: Use a project as an autonomous work queue - listeners, round-robin or ack mode, timeouts, dead letters, the listener wake and the megaphone.
---

Up: [orgtree-collaboration-patterns](../SKILL.md)

# Projects as work queues

Depending on how it is set up, a project can run as an autonomous work queue. Mail posted to the project's own mailbox is handed out to the agents listening on it, one mail to one agent, without anyone routing it by hand. Use it for a stream of similar jobs (tickets to triage, pages to translate, checks to run) that any of several agents can take.

## Concurrency analogies in Project settings

- Round-robin works like a load balancer: each job goes to the least recently woken listener.
- ACK works like a FIFO work queue: jobs in order, up to each listener's batch size unacked (default 1), with retries and dead letters.
- One slot works like a shared lock (mutex); several slots work like a counting semaphore. 0 = no concurrency slots.

These describe cooperative patterns: slot holders agree to claim and release permits; the engine does not enforce a limit on the work itself. FIFO describes job handout order, not completion order across listeners. Retry/dead-letter behavior follows the acknowledgement settings below.

## The pieces

- **Listeners.** An agent listens with `orgtree_watchdog action=create kind=fair_queue target=<project>`. Only agents above or below the project can listen. A paused or removed watchdog stops listening.
- **The project's mailbox.** Anyone who reaches the project posts with `orgtree_message to=<project>`; the user posts from the project desk's message box. Mail waits there until a listener can take it.
- **Queue mode** (project settings, "Mail queue"):
  - **Round-robin** (the default, for throughput): each mail goes out as soon as it arrives, to the listener woken least recently. No ack is needed.
  - **Ack mode** (completion records): each listener holds up to its `batch` size in unacked mails (1–20, default 1). Ack each mail separately with `orgtree_message to=<project> reply_to=<the mail's id>` and a short completion record. The ack is kept in the project's mailbox as a read record, frees one batch place and triggers dispatch of waiting work. Every handed mail's wrapper says whether it needs an ack and how; armed and paused agent listeners get a notice whenever the mode changes.
- **Turn-end reminder** (ack mode, project setting "Remind an agent that ends its turn with an un-acked job", **on by default**): queues one immediate nudge per held assignment, subject to the delivery and turn-outcome conditions below. It is normal mail, not a guaranteed extra turn or completion. Disable it with `orgtree_project action=configure settings={"turn_end_reminder":false}`.
- **Ack timeout** (ack mode, on by default): with Runtime working checkups on, each outstanding agent job gets its configured **Ack reminders** budget (integer 1–10, default 3); the next eligible checkup reclaims it. Nonterminal jobs return to the front of the queue. Checkups depend on inactivity and runtime eligibility, so this is not a precise wall-clock deadline.

The turn-end reminder is separate from both timeout switches and does not use
the checkup reminder budget. It applies only after the handed copy was consumed
and a successful ordinary turn ended; failed/interrupted/compacting/session-end
turns do not trigger it. A fresh, nonempty blocked status suppresses the
immediate reminder, not later eligible timeout checks.

Switching from ACK to round-robin waives outstanding ACK requirements,
including user-held assignments; it does not manufacture completion records.
Switching into ACK does not retroactively require ACKs for earlier
round-robin deliveries.

The user may join the same queue with batch 1–20 from the desk. Their held jobs
remain until they acknowledge, even after leaving the queue; no timeout or
take-back reclaims them. Exclude-sender also excludes the user's own posts.
Purge retracts currently pending/unassigned jobs, including returned jobs with
an earlier attempt, while held/acked/dead-letter records remain.

**Dead Letter Line** in Mail → listeners lists notification watchdogs, not
jobs: up to 200 matching armed/paused `event` dogs on `project.dead_letter` or
`project.*`. Paused rows do not receive events. Its pattern preview uses a
project-only synthetic event line, so payload-specific filters may be absent.
The repository's `docs/skills/orgtree-workflows/collaboration-patterns/work-queues/source-audit.md`
records the exact implementation references; it is not a bundled glossary page.

## Project audiences

A live project may hold an audience with the user, another agent or another project. Every live agent directly under it can use that audience exactly as if it held the grant itself: user mail, questions, presentations, file delivery and agent mail all accept effective inherited access. Tool groups and other independent permissions still apply. Only direct members inherit; a nested project never relays its parent's inherited grants to deeper agents. Moving out, retiring, pausing or revoking the source grant removes that inherited route. An agent's independent explicit grants remain.

An audience is directional: a grant to project A from project B lets A's direct agents write to B and B's direct agents while **both projects' peer-mail switches are ON**. It does not let B's agents write back. A reverse grant enables that reverse direction, subject to the same switches. Turning either switch OFF suspends that project-to-project route; explicit agent-to-agent, agent-to-project and project-to-agent grants keep their ordinary override. Members of nested projects, unrelated organizations and retired members are excluded. No personal audience rows are copied to members.

When the user sends to a project's mailbox or uses its megaphone broadcast, only the project receives an explicit user audience after successful delivery. The broadcast reaches live agent children through live sub-projects, stopping at each agent, but creates no personal user grants on any recipient. Fair-queue copies and system nudges likewise create no personal user grants. A post-delivery project grant failure is reported as delivered but audience grant failed.

Direct user mail or commands create an agent's own user grant only when it has no effective user audience already. While it inherits user access from a project, user mail of any kind does not give it an independent grant. To give it one, the user can choose Acquire audience in that agent's context menu, even while it inherits access; alternatively, remove the project's user audience and then mail the agent directly. Once an inherited-only agent leaves the project, its inherited access ends; direct user contact can then grant it access normally. Existing explicit grants are not removed automatically.

A project's nearest real-agent superior manages its audience requests and decisions; the user does so if there is no such superior. Members cannot manage the project's grants. Use orgtree_audience action=request from=project-name target=agent-or-project for a managed project; its context menu also offers Acquire/Drop audience. Chart and state inspection identify inherited source projects. Drop audience acts on explicit grants, not inherited-only routes; change the source project's grant to remove an inherited route. The org-inbox/outside-mail audience remains agent-only. The separate permission to present within one's own project includes nested members and does not imply recursive audience inheritance.

For exact load-balancer/FIFO job, acknowledgement, retry/dead-letter and signal-vs-broadcast calls, open [orgtree-concurrency-primitives](../concurrency-primitives/SKILL.md). This page owns queue settings and operational details.

## Recipe

1. Create the project and hire the workers under it; put the job's standing instructions in the project's Summary (`description` setting; it is every worker's standing charter).
2. Have each worker arm `orgtree_watchdog action=create kind=fair_queue target=<project>`. With the listener wake on, the first user mail to an unwatched project asks one worker to do this.
3. Choose the mode in project settings: round-robin when jobs are quick and independent; ack mode when each job needs a completion record or must not pile up on one worker. In ack mode, keep the ack timeout on and set max attempts to how often a job may be retried.
4. Post jobs to the project, one mail per job (`orgtree_message to=<project>`, or the project desk's message box with the megaphone off).
5. Watch the project desk's Mail tab: each mail shows who holds it, whether it is awaiting an ack, acked, released or dead-lettered. Purge what should no longer run.

For what a project is, see `orgtree-projects` (orgtree-working › team); for the fair_queue watchdog, `orgtree-tool-watchdog` (orgtree-working › watchdogs); for posting jobs and acks, `orgtree-tool-message` (orgtree-working › mail). For a worked use of an ACK queue, with integration jobs handed to a pool, see [orgtree-implement-integrate](../implement-integrate/SKILL.md).
