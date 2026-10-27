---
name: orgtree-implement-integrate
description: Split writing code from integrating it - implementers post self-contained jobs to a project queue and a small pool of integrators verifies and hands them in.
---

Up: [orgtree-collaboration-patterns](../SKILL.md)

# Implement, then integrate through a queue

Use this pattern when the people (or models) best at writing code are costlier than the people who can do the mechanical, token-heavy work around it: rebasing, builds, test runs, captures, audits and evidence. The implementer writes the change and the failing test that defines it, then posts one self-contained job. A small pool of integrators takes jobs from a project queue, one at a time, and either hands in a verified commit or bounces the job back with exact output. The pattern is a team agreement built from existing pieces: a project mailbox in ACK mode, queue listeners and build-slot permits. It grants no build, push, release or live-data authority; the assignment still does.

It adds a handoff. For a small change, or a team that cannot spare an integrator, the [dev-team](../dev-team/SKILL.md) default stands: the implementer assembles and verifies its own work.

## Roles

| Role | Does | Never does |
| --- | --- | --- |
| Implementer | Writes the product change and the defining failing ("red") test on its own private branch, confirms it compiles, posts one job per item, stays reachable and fixes every bounce. | Hands over the code or the test; leaves a job vague. |
| Integrator (a pool) | Takes the next job, rebases the exact commit onto the integration line in its own worktree, claims a build permit, runs the named red, green, compile and audit commands, runs the capture checklist, records evidence and hands the verified commit to the integration owner. | Edits product code, tests or docs. Fixes a failure, however small. |
| Integration owner | Reads the evidence, fast-forwards the shared line, builds, releases and decides what ships. | Listens on the queue. |

The Implementer and Integrator charter presets carry the role text; see orgtree-charters (orgtree-working › team) and orgtree-app-charters-and-templates (orgtree-app › app-settings). A preset supplies text only. The Implementer preset keeps final integration with the implementer unless the team runs such a pool. The queue, listeners, folders, tools and permits are set up separately.

## The job mail

One job per item, posted to the queue project with `orgtree_message` kind=request. The body names every field below, so an integrator that has never seen the conversation can run it:

| Field | Content |
| --- | --- |
| item | The docket item whose scope defines done. |
| implementer | Who receives bounces. |
| branch, tip, base | The branch, the full commit ID to integrate and the full commit ID it was written on. |
| target | The integration line to rebase onto (the tip the owner names, else the base). |
| kind | What gets built or checked: renderer, engine, both or docs-only. |
| red | The exact command and the test names that must fail at the base. |
| green | The exact command and the test names that must pass at the tip. |
| typecheck/compile | The exact command. |
| capture | Either "none" or a checklist: screen, setup data, window size, theme, and each pass criterion stated as a visible fact. |
| docs | Files the commit already changes, or "none". |
| notes | What the integrator must not do or must know, else "none". |

```
INTEGRATION JOB
item: <docket item>
implementer: <agent>   (bounces go here)
branch: <branch>   tip: <full commit ID>   base: <full commit ID>
target: <integration line>
kind: <renderer | engine | both | docs-only>
red: <command> -> <tests failing at base>
green: <command> -> <tests passing at tip>
typecheck/compile: <command>
capture: <none | checklist with pass criteria>
docs: <files already changed, or none>
notes: <anything else, or none>
```

## How an integrator runs a job

1. Read the job and the item's full scope. Add yourself as a participant if the docket requires it.
2. Fetch, make a private worktree, check out the tip detached and rebase it onto the target on a new branch. Resolve a conflict only when it is purely mechanical (both sides kept verbatim, such as adjacent list lines). Anything touching logic, tests or wording: abort and bounce. After the rebase, look for mangled text and for shared notes that grew past their size limit; either is a bounce.
3. Claim a build permit as the [build-slots](../build-slots/SKILL.md) page describes, read fresh free memory against the project's current Summary, then run red at the base, green at the rebased tip, compile or typecheck and the audits, one run each, and release the permit at once.
4. Run the capture checklist if there is one, isolated and muted. View every image and record each line as pass or fail.
5. Never edit product code, tests or docs. The rebase is the only change to the repository; harness scripts live outside it.
6. Outcome. All pass: record the evidence on the item and send the integration owner the rebased commit and branch, each result with its numbers, the capture paths and the audit result. Any failure: send the implementer the exact failing command and the tail of its output, the conflict hunks or the failing checklist line with its image. No fixes, and one rerun at most for a flaky-looking test.
7. Acknowledge the job, then take the next one.

## The queue underneath

The mechanics live in other pages; this pattern only chooses settings.

- **Mailbox.** The jobs go to a project set to ACK mode, so mail is handed out first in, first out and each integrator holds one job at a time. [work-queues](../work-queues/SKILL.md) owns the settings; [concurrency-primitives](../concurrency-primitives/SKILL.md) has the worked calls. Implementers need reach to the project to post, and only agents above or below it can listen.
- **Listeners.** Each integrator arms `orgtree_watchdog action=create kind=fair_queue target=<project> batch=1`. With batch 1, a second job waits for an acknowledgement.
- **Acknowledgement means handled.** The integrator replies to the job's own mail ID with `orgtree_message to=<project> reply_to=<job mail id>` and a short record: handed in, with the commit, or bounced, with the reason. An acknowledgement is not "passed"; success is the hand-in, which the owner reads in the evidence.
- **Timeout and dead letters.** An integrator that never acknowledges is reminded at its working checkups (the default is three), after which the job returns to the front of the queue; after `max_attempts` reclaims (default 3) it becomes a dead letter, reported to the project's nearest live agent above it. An event watchdog on `project.dead_letter` wakes whoever should decide to retry or drop it. A bounce is an acknowledgement, not a reclaim: the implementer's fix is a new job, and its own attempts start again. A reclaimed job can run twice, so an integrator checks for an existing worktree, branch or hand-in for that job before starting over.
- **Build permits.** Integrators claim permits from a build project that all of them reach, the same project as the queue or a sibling, per [build-slots](../build-slots/SKILL.md). A job is not a permit: claim only for the heavy phase and release right after, even on failure.

## Trade-offs

- **Handoff overhead.** Writing a complete job costs the implementer effort, and a short or ambiguous job costs the pool a bounce. Worth it when integration is a large share of the work; not worth it for a one-line fix.
- **Bounce cost.** By the time a bounce arrives, the implementer may have moved on, compacted or been retired. Keep jobs small, give the exact commands and expected test names, and put the failing output in the bounce so the fix needs no reproduction.
- **Pool size against build slots.** Integrators queue for the same permits as every other builder. A pool larger than the permits' capacity only adds integrators waiting while holding jobs, which an acknowledgement timeout can read as idleness. Start with one or two.
- **Order.** First-in, first-out is handout order, not completion order. Two jobs touching the same lines can conflict; the later one is rebased on whatever the owner has already integrated, and a non-mechanical conflict bounces.
- **Verification is not review.** A clean integration shows that the change rebases, builds and passes the named checks. It does not replace independent review where the project's phase calls for it; see orgtree-reviews-and-landing (orgtree-working › workspace) for exact-commit evidence.

## Set it up

1. Choose or create the queue project and place the integrators below it, or the project below a manager who reaches both sides. Configure ACK mode, ack timeout, reminders and `max_attempts`.
2. Confirm the build project's permits and put the current resource policy in its Summary; orgtree-builds-under-the-lock (orgtree-working › workspace) holds the claim and release mechanics.
3. Hire the integrators with the Integrator charter and give them edit and bash for their own harness and evidence folders, without any push or release authority. Keep the implementers on the Implementer charter and tell them a pool exists.
4. Put the job format above, the target line and the bounce rule in the queue project's Summary, so it is one standing home rather than a repeated message.
5. Have each integrator arm its listener. Post one job per item; watch the project desk's mail tab and the dead-letter watchdog.

## See also

- [orgtree-dev-team](../dev-team/SKILL.md): the default when the implementer integrates its own work.
- [orgtree-work-queues](../work-queues/SKILL.md) and [orgtree-concurrency-primitives](../concurrency-primitives/SKILL.md): the queue settings, ACK semantics and worked calls.
- [orgtree-build-slots](../build-slots/SKILL.md): permits for the integrators' heavy phases.
- [orgtree-iterative-development](../iterative-development/SKILL.md): where hand-ins sit in a release process.
- `orgtree-charters` (orgtree-working › team) and `orgtree-app-charters-and-templates` (orgtree-app › app-settings): the Implementer and Integrator presets.
- `orgtree-tool-message` (orgtree-working › mail), `orgtree-tool-watchdog` (orgtree-working › watchdogs), `orgtree-tool-project` (orgtree-working › team) and `orgtree-tool-work` (orgtree-working › docket): posting and acknowledging jobs, listening, queue settings and evidence on the item.
- `orgtree-reviews-and-landing` and `orgtree-builds-under-the-lock` (orgtree-working › workspace): exact-commit evidence and permit mechanics.
