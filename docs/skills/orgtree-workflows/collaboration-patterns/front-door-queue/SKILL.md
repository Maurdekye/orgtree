---
name: orgtree-front-door-queue
description: Run an org with a project in place of a coordinator - the project holds the org-inbox audience and a worker pool takes each outside message as a queued job.
---

Up: [orgtree-collaboration-patterns](../SKILL.md)

# Queue project in place of a coordinator

Most orgs put one coordinator agent between the outside world and the work. This is the alternative: a **front-door project** holds the org-inbox audience, and a pool of workers below it takes the outside mail as jobs from the project's [work queue](../work-queues/SKILL.md). No agent sits in the middle deciding who handles what.

## The shape

- A top-level project holds the org-inbox audience, exactly as an agent node would (drag it onto the org mailbox, or `orgtree_audience action=grant from=<project> target=extern`). Its members inherit nothing from the grant. Workers under a holding project reply to outside people only through their jobs: for outside mail, members of a holding project are not top-level agents, so they cannot start an outside conversation or be auto-granted the audience.
- Workers sit below the project and each arm a `fair_queue` listener on it.
- Optionally an agent holder (the liaison) keeps its own copies of every message: turn on the org's multiple-holder option and grant both. With that option off, the newest grant wins, so granting the project replaces the agent holder (the drag asks first).

## What arrives

- Every outside message becomes one job in the project's mailbox, with the exact outside sender and the `(outside party · see EXTERN)` tag. Agent holders get their ordinary copies at the same time.
- **The user's linked phone arrives too, and carries the user's authority, as in any agent's copy** (the app-wide Connect your phone note, or org.md, applies to every worker identically). Say plainly in the project Summary that every worker acts on such a message, and choose their models with that in mind. With several holders, one phone command reaches several actors and they may act on it twice; that is the cost of the multiple-holder option.
- Org Do Not Disturb still holds everything first; released mail becomes jobs in order.

## ACK on or off

| | ACK mode | Round-robin |
| --- | --- | --- |
| Custody | FIFO, one job per listener place, retries, dead letters | each job goes out at once to the least recently woken listener |
| Reply right | a worker may reply to the sender until it acks the job; the ack sends nothing outside | no limit: reply as often as needed |
| Choose it when | every message must be finished and recorded; you want timeouts and dead letters | fire-and-forget handling, throughput first |

A worker replies with `orgtree_message to=<the outside sender> reply_to=<the job copy's id>`; the reply leaves from the org inbox. It can reply only to that job's own sender. Taking the job back, or acking it in ACK mode, ends the right.

## Conversations

- The outside person's **reply to a worker's message** goes straight to that worker (never the queue), and the worker keeps its reply right while the job allows it. A reply to a halted worker waits for it. If the worker was retired, the reply goes to every holder.
- Their **follow-up to their own earlier message** goes to whoever received that message: bundled with the job if it has not been handed out yet, straight to the worker who holds it (ACK mode, not yet acked), or as a new threaded job if it was acked, handed out in round-robin, or lost.
- `@org:` mail threads the same way, through a stable message id that both orgs keep.

Internal mail works the same way: a worker answers the agent or user that sent the job, and that sender's follow-ups reach the same worker while the job is open (the job route, `orgtree-tool-message`).

## When to choose it

- Many similar, independent requests: support, intake, triage.
- Several workers on equal footing, throughput over central judgment.

## Limits

- No central triage or prioritisation: jobs go out in order.
- No cross-job memory: a worker sees only its own jobs. Put standing guidance in the project Summary.
- Outsiders cannot address a specific project; there is one org address.
- Workers act with delegated user authority on phone mail, so seat model choice matters.
- Duplicate action is possible with several holders.
- Single-holder mode replaces the existing holder.

## Setup recipe

1. Create the project and write its Summary: reply tone, what never to disclose, when to escalate.
2. Hire workers under it; each arms `orgtree_watchdog action=create kind=fair_queue target=<project>`.
3. Pick the mode and its batch, timeout and attempts (project settings, "Mail queue").
4. Turn on multiple org-inbox holders if an agent should keep copies too.
5. Drag the project onto the org mailbox.
6. Watch the project's Mail tab and its dead letters; escalate by mail to the project's superior.

## See also

[orgtree-work-queues](../work-queues/SKILL.md) · orgtree-org-inbox (orgtree-working › mail) · orgtree-external-mail (orgtree-working › mail) · orgtree-team-shape (orgtree-working › team)
