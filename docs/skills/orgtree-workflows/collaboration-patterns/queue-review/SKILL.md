---
name: orgtree-queue-review
description: Review a long list of commits one at a time through a project queue, then collate and classify the findings before routing defects.
---

Up: [orgtree-collaboration-patterns](../SKILL.md)

# Per-commit review through a project queue

Use this pattern when a large change set (a release, a long-lived branch, an imported history) must be reviewed and each commit deserves a reviewer's full attention. A pool of reviewer agents sits under a project. The coordinator posts one job per commit to the project's mail queue, each reviewer takes one job at a time, writes one review file for it and acknowledges the job, and a later stage collates the files and classifies every finding before anything reaches an implementer. Speed is not the goal: the queue exists so that no reviewer skims.

## Why a queue, not fixed batches

Handing each reviewer a fixed batch of a few dozen commits invites skimming; in one observed run a reviewer finished 25 commits in about three minutes. It also balances badly: a reviewer whose batch is short goes idle while another still works through a long list. A queue fixes both. Every job is one commit, one reviewer gets exactly one job per turn, and the next job goes to whichever seat frees first. The reviewer's whole turn is spent on that commit.

The model for each role is a choice, not a requirement: for example, a thorough mid-tier model can review while a different, careful one checks. Pick the models the team's rules allow.

## Roles

| Role | Does | Never does |
| --- | --- | --- |
| Coordinator (the owner) | Builds the manifest of commits, posts one job per commit, reads the collated packets and routes confirmed open defects to their implementers. | Reviews in the reviewers' place, or sends an implementer a finding the checker has not classified. |
| Reviewer (a pool under the review project) | Takes one job, reads the whole commit and the code around it at that commit, writes one review file, acknowledges, ends the turn. | Reads other reviews, edits the repository, builds, runs tests or the app, or mails the coordinator per job. |
| Checker | Collates a group's review files into a packet and classifies each finding against the release tip. | Reviews commits afresh, edits product code, or contacts implementers. |
| Implementer | Receives confirmed open defects as ordinary docket work. | Gets raw review files. |

## The pieces

- **A review project.** A project node holds the reviewer seats and owns the queue. Set its mail queue to ACK mode ([work-queues](../work-queues/SKILL.md) owns the settings) so jobs go out first in, first out and each reviewer holds one at a time. Put the standing reviewer brief, or a link to it, in the project's Summary so it is one home rather than a message repeated per job.
- **A manifest.** The list of commits to review, in groups (for example one group per milestone build). Each entry has the full commit ID, its subject, its group and whether it is a merge.
- **An output folder.** One folder for the review files, with a sub-folder per group, writable by the reviewers and nothing else. The checker's packets go in a sibling folder.
- **Read-only access to the repository.** A checkout the reviewers read with `git show`, `git log`, `git grep`, `git blame` and `git diff` only. They never check out, commit, stash, reset, fetch, build or run anything, so reviewing needs no build permit.

## The job mail

One job per commit, posted to the project with `orgtree_message` (megaphone off), so the mail queue hands it to exactly one listening reviewer. The body carries every field the reviewer needs:

| Field | Content |
| --- | --- |
| job | Its number and the total, such as `REVIEW JOB 017/462`. |
| sha | The full commit ID. |
| subject | The commit's subject line. |
| group | The group it belongs to, such as the milestone build. |
| merge | `yes` or `no`. |
| output path | The exact review file to write. |

```
REVIEW JOB <nnn>/<total>
sha: <full commit ID>
subject: <subject>
group: <group>
merge: <yes | no>
output: <path of the review file to write>
```

## How a reviewer runs a job

1. **Arm one listener, once.** On the first turn the reviewer creates a single persistent queue listener: `orgtree_watchdog action=create kind=fair_queue target=<review project> name=<name> once=false batch=1`. It then keeps that listener for good. If the create result already hands over a job, do it.
2. **Read the whole commit.** `git show --stat <sha>`, then `git show <sha>`. For a merge, use `git show --remerge-diff <sha>` and review only the conflict resolution.
3. **Read the surrounding code at that commit** for every changed hunk: `git show <sha>:<path>`, callers and callees through `git grep -n <symbol> <sha>`, and the tests the commit adds or changes. Check the rules the code answers to: the repository's AGENTS.md, its decisions record and the topic docs the commit touches. A behavior that a recorded user ruling requires is not a defect.
4. **Look for defects only, never style:** correctness, regressions of existing behavior, crashes and unhandled errors, races and lock order, data loss, security and privacy (secrets, paths, unsafe HTML or IPC, permission bypass, credential leaks), resource leaks, broken migrations, tests that cannot fail or test the wrong thing, documentation that contradicts the code and wrong user-visible text. Every finding names a concrete line and a concrete failure scenario.
5. **Review this commit on its own.** Do not read other reviews and do not assume what later commits do. Independence is the point: the same defect found twice by two readers is a stronger signal than one reader's note.
6. **Write the review file** in the fixed format below, at the path in the job. For a diff over about 3,000 changed lines, review code first, then tests and docs, and list what was skipped under `skipped:`.
7. **Acknowledge, then end the turn.** Reply to the job's own mail ID with `orgtree_message to=<review project> reply_to=<job mail id>` and the body `DONE <sha12> CLEAN` or `DONE <sha12> FINDINGS(<n>)`, only after the file is written. Ending the turn lets the listener deliver the next job. Each job stands alone, so a long context does no harm.

Reviewers do not mail the coordinator for each job. They escalate only a job they cannot read (a bad commit ID) and a high-severity security or data-loss finding, in one line plus the file path.

### The review file

```
# <full commit ID>
job: <nnn>
subject: <subject>
author: <git author name>
group: <group>
files: <count> (<up to 6 paths>)
verdict: CLEAN | FINDINGS

## F1
severity: high | medium | low
category: correctness | regression | crash | concurrency | data-loss | security | leak | migration | test | docs | ui-text
location: <path>:<line> (at this commit)
defect: <one sentence>
scenario: <concrete inputs or state -> wrong result>
evidence: <the exact code lines, quoted, at most six>
```

A CLEAN review has no finding sections and one `notes:` line saying what was checked. Severity: high is a crash, data loss, a security problem or a main user flow broken; medium is wrong behavior in a real but narrower case; low is an edge case, misleading text or a weak test.

## After the reviews

1. **Collate per group.** Start a group only when every commit in it has a review file with a `verdict:` line. The checker lists missing or malformed files (no verdict, CLEAN with finding sections, FINDINGS with none) under a Coverage gaps heading and the coordinator is told at once; the rest of the packet continues.
2. **Classify every finding.** The checker opens the code itself and gives each finding exactly one class:
   - **CONFIRMED-OPEN.** The defect is real at the commit and the same defective code is still present at the release tip. The packet states the failing scenario, the evidence at the tip and an owner hint (the commit's author, or the docket item it names).
   - **CONFIRMED-FIXED.** Real at the commit, but a later commit up to the tip fixed it; the fixing commit is named.
   - **NOT-A-DEFECT.** The evidence does not match the file, the scenario cannot happen (the guard or caller line is shown) or a recorded user ruling requires the behavior (cited).
   - **DUPLICATE.** The same root defect as another finding; only the original is classified.
   - **UNSURE.** It cannot be decided from the code; the packet says exactly what is missing. Rare, and never a way to avoid reading.

   The checker keeps the reviewer's severity unless it is clearly wrong by the definitions above, and then writes both. It adds no findings of its own, except a plainly high-severity defect seen at the tip, which goes under a separate "Checker-found (unreviewed)" heading.
3. **Write one packet per group:** the tip checked, the counts per class, then a section per class in the order CONFIRMED-OPEN (high to low), CONFIRMED-FIXED, NOT-A-DEFECT, DUPLICATE, UNSURE, Coverage gaps and Checker-found. Every finding appears in exactly one section. The checker reports the counts to the coordinator and takes the next group.
4. **The coordinator reads the packets** and routes each confirmed open defect to its implementer as ordinary docket work, with the packet entry as the scope. Nothing unclassified goes to an implementer.

## Trade-offs

- **Cost against attention.** Every job is a full turn that reads a commit and its surroundings. A long list takes hours and many tokens. That is what the pattern buys; for a handful of commits, one reviewer reading them in sequence is enough.
- **Independence has a price.** Reviewers do not see each other's work, so the same defect can be reported more than once. The checker's duplicate class absorbs that.
- **Ack timeouts.** A careful review of a large commit is slow. Set the project's ack timeout and reminders generously, or the checkup logic can read a slow reviewer as idle and return its job to the queue; after the maximum number of reclaims, a job becomes a dead letter. See [work-queues](../work-queues/SKILL.md) and [concurrency-primitives](../concurrency-primitives/SKILL.md).
- **Pool size.** More reviewers finish sooner but increase simultaneous reads of the same checkout and the load on model usage windows. Check account capacity before widening the pool.
- **Review is not integration.** A clean review finds defects by reading; it does not show that the change builds or passes tests. For that, see [implement-integrate](../implement-integrate/SKILL.md).

## Set it up

1. Create the review project with its queue in ACK mode, generous ack timeout and the reviewer brief in its Summary. Hire the reviewers under it with bash for reading the checkout and edit access to the output folder only; give them no push or release authority.
2. Build the manifest from the commit list, split it into groups and decide the release tip to check against.
3. Hire or name the checker and give it the packet brief; it needs read access to the reviews, the checkout and the packet folder.
4. Post one job per commit. Watch the project desk's mail tab and the dead-letter watchdog; reviewers arm their listeners on their first turn.
5. When a group is complete, wake the checker for it; when its packet is done, read it and route the confirmed open defects.

## See also

- [orgtree-work-queues](../work-queues/SKILL.md) and [orgtree-concurrency-primitives](../concurrency-primitives/SKILL.md): ACK mode, listeners, acknowledgements, reclaims and dead letters.
- [orgtree-implement-integrate](../implement-integrate/SKILL.md): the sibling pattern for rebasing, building and testing a commit through a queue.
- [orgtree-dev-team](../dev-team/SKILL.md) and [orgtree-iterative-development](../iterative-development/SKILL.md): the redteam role and the release process this review feeds.
- `orgtree-tool-message` (orgtree-working › mail), `orgtree-tool-watchdog` (orgtree-working › watchdogs), `orgtree-tool-project` (orgtree-working › team) and `orgtree-tool-work` (orgtree-working › docket): posting and acknowledging jobs, arming the listener, queue settings and routing defects as docket work.
- `orgtree-reviews-and-landing` (orgtree-working › workspace): exact-commit review evidence before a landing.
