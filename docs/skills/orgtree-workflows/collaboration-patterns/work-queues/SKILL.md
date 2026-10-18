---
name: orgtree-work-queues
description: Use a project as an autonomous work queue - listeners, round-robin or ack mode, timeouts, dead letters, the listener wake and the megaphone.
---

Up: [orgtree-collaboration-patterns](../SKILL.md)

# Projects as work queues

Depending on how it is set up, a project can run as an autonomous work queue. Mail posted to the project's own mailbox is handed out to the agents listening on it, one mail to one agent, without anyone routing it by hand. Use it for a stream of similar jobs (tickets to triage, pages to translate, checks to run) that any of several agents can take.

## Concurrency analogies in Project settings

- Round-robin works like a load balancer: each job goes to the least recently woken listener.
- ACK works like a FIFO work queue: jobs in order, one per listener until it acks, with retries and dead letters.
- One slot works like a shared lock (mutex); several slots work like a counting semaphore. 0 = no concurrency slots.

These describe cooperative patterns: slot holders agree to claim and release permits; the engine does not enforce a limit on the work itself. FIFO describes job handout order, not completion order across listeners. Retry/dead-letter behavior follows the acknowledgement settings below.

## The pieces

- **Listeners.** An agent listens with `orgtree_watchdog action=create kind=fair_queue target=<project>`. Only agents above or below the project can listen. A paused or removed watchdog stops listening.
- **The project's mailbox.** Anyone who reaches the project posts with `orgtree_message to=<project>`; the user posts from the project desk's message box. Mail waits there until a listener can take it.
- **Queue mode** (project settings, "Mail queue"):
  - **Round-robin** (the default, for throughput): each mail goes out as soon as it arrives, to the listener woken least recently. No ack is needed.
  - **Ack mode** (one job at a time, with completion records): each listener holds ONE mail. It gets no more until it acks that one with `orgtree_message to=<project> reply_to=<the mail's id>` and a short completion record. The ack is kept in the project's mailbox as a read record and immediately hands the acker the next waiting mail. Every handed mail's wrapper says whether it needs an ack and how; listeners get a notice whenever the mode changes.
- **Turn-end reminder** (ack mode, project setting "Remind an agent that ends its turn with an un-acked job", **on by default**): when a listener's turn ends while it still holds an un-acked job, the engine starts ONE new turn for it right away with a reminder naming the job (its mail id and first line): finish it and ack, or set your status to blocked with the reason. It fires once per held job; afterwards the 20-minute ack timeout applies unchanged. No immediate reminder if the listener's latest status, set after it took the job, is `blocked` with a reason (that job gets only the 20-minute reminders), if the listener is halted, frozen or out of usage, or if the turn was interrupted or failed. It is not forced to keep running; it just gets one turn. Turn it off in project settings (or `orgtree_project action=configure settings={"turn_end_reminder":false}`).
- **Ack timeout** (ack mode, on by default): a listener sitting on an un-acked mail gets the 20-minute working checkup up to 3 times; after that the mail is taken back and goes to the front of the queue for another listener.
- **Max attempts** (ack mode, default 3): a mail handed out that many times without an ack becomes a **dead letter** instead, and the project's superior (the user, for a top-level project) is told. A dead letter keeps the mail, its sender, the attempt history (who held it, when, how each hand-out ended) and the final reason. Anyone above or below the project can list and read them (`orgtree_project action=dead_letters name=<project>`, `id=` for one in full; the project desk's **dead letters** tab), retry one (`retry_dead_letter`: back in the queue with its attempts reset, history kept) or drop one with a reason (`drop_dead_letter`). To be alerted, arm `orgtree_watchdog action=create kind=event target=project.dead_letter` (agents above or below the project only). The ack timeout and max attempts only work while Runtime's "check on working agents after 20 minutes" is on, which it is by default.
- **What the sender is told.** A post that waits in the queue says why: with no listener, "No agent watches the project ..."; with listeners that are all holding an un-acked job, "N listeners, all holding an un-acked job; it is handed out as soon as one of them acks" with its place in line ("position k in line"); with halted listeners, how many are halted; with only paused listeners, that they are paused. The same wording is in the user's send reply and in `orgtree_inbox project=<name>` (`queue`).
- **One listener per agent.** An agent may hold ONE un-acked job per project in ack mode, however many fair_queue watchdogs it has. Creating a second fair_queue watchdog on a project you already watch is refused, naming the one you have (resume it if it is paused).
- **Released mail.** An un-acked mail goes back to the front of the queue when its holder is retired or halted, or stops listening.
- **Never hand an agent its own mail** (off by default): when on, a listener that posts to the project is not handed its own mail; the mail waits for another listener.
- **Purge.** The project desk's inbox tab can purge the mail still waiting (after a confirmation); handed, acked and dead-letter mail stays.
- **The listener wake** (Runtime settings, "wake an agent to listen for project mail", on by default): when the user writes to a project nobody listens on, one agent directly under it (an idle one first) is woken and asked to arm a fair_queue watchdog.
- **The megaphone** on the project desk's message box sends one message to every live agent under the project instead of to the queue: for announcements, not jobs.

## Project audiences

A live project may hold an audience with the user, another agent or another project. Every live agent directly under it can use that audience exactly as if it held the grant itself: user mail, questions, presentations, file delivery and agent mail all accept effective inherited access. Tool groups and other independent permissions still apply. Only direct members inherit; a nested project never relays its parent's inherited grants to deeper agents. Moving out, retiring, pausing or revoking the source grant removes that inherited route. An agent's independent explicit grants remain.

An audience is directional: a grant to project A from project B lets A's direct agents write to B and B's direct agents. It does not let B's agents write back. A reverse grant enables that reverse direction; with both grants, the two projects' direct agents may all correspond with one another. Members of nested projects, unrelated organizations and retired members are excluded. No personal audience rows are copied to members.

When the user sends to a project's mailbox or uses its megaphone broadcast, only the project receives an explicit user audience after successful delivery. The broadcast reaches live agents below it, including nested agents, but creates no personal user grants on any recipient. Fair-queue copies and system nudges likewise create no personal user grants. A post-delivery project grant failure is reported as delivered but audience grant failed.

Direct user mail or commands create an agent's own user grant only when it has no effective user audience already. While it inherits user access from a project, user mail of any kind does not give it an independent grant. To give it one, the user can choose Acquire audience in that agent's context menu, even while it inherits access; alternatively, remove the project's user audience and then mail the agent directly. Once an inherited-only agent leaves the project, its inherited access ends; direct user contact can then grant it access normally. Existing explicit grants are not removed automatically.

A project's nearest real-agent superior manages its audience requests and decisions; the user does so if there is no such superior. Members cannot manage the project's grants. Use orgtree_audience action=request from=project-name target=agent-or-project for a managed project; its context menu also offers Acquire/Drop audience. Chart and state inspection identify inherited source projects. Drop audience acts on explicit grants, not inherited-only routes; change the source project's grant to remove an inherited route. The org-inbox/outside-mail audience remains agent-only. The separate permission to present within one's own project includes nested members and does not imply recursive audience inheritance.

## Recipe

1. Create the project and hire the workers under it; put the job's standing instructions in the project's Summary (`description` setting; it is every worker's standing charter).
2. Have each worker arm `orgtree_watchdog action=create kind=fair_queue target=<project>`. With the listener wake on, the first user mail to an unwatched project asks one worker to do this.
3. Choose the mode in project settings: round-robin when jobs are quick and independent; ack mode when each job needs a completion record or must not pile up on one worker. In ack mode, keep the ack timeout on and set max attempts to how often a job may be retried.
4. Post jobs to the project, one mail per job (`orgtree_message to=<project>`, or the project desk's message box with the megaphone off).
5. Watch the project desk's inbox: each mail shows who holds it, whether it is awaiting an ack, acked, released or dead-lettered. Purge what should no longer run.

For what a project is, see `orgtree-projects` (orgtree-working › team); for the fair_queue watchdog, `orgtree-tool-watchdog` (orgtree-working › watchdogs); for posting jobs and acks, `orgtree-tool-message` (orgtree-working › mail).
