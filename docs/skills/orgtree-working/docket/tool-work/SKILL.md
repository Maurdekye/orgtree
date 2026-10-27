---
name: orgtree-tool-work
description: Read and maintain durable docket items through every supported action, ownership rule, status and attention mechanism.
---
Up: [orgtree-docket](../SKILL.md)

# orgtree_work

## Call contract

Manage durable work by readable slug. create requires objective (problem/solution first, full scope after). update supplies both progress lists or keep/append; it CLAIMS ownership unless owner=current holder. blocked/dropped need reasons. Add participants before assignment/review requests. Review is agent review; user questions use ask(work_item), nonquestion attention needs a reason. delete is permanent, limited to user/owner's superior/top-level owner and refused with children/open questions; prefer archive/dropped. Read guide before first docket write.

Requires `docket`. Use for substantive work whose scope, ownership, progress and evidence must survive a session. Start by listing existing readable items; continue the same item through review, handoff and resumed work. A request to "dock" a feature means create its item, not automatically implement or deploy it.

## Actions and authority

`action` is required. Every action except list/create also requires `slug`, the fixed readable name returned at creation. Use that identity everywhere even after retitling.

| Action | Inputs and effect |
| --- | --- |
| `list` | Read visible groups, optional include_archived/include_backlogged/projection/fields. |
| `get` | Read slug, optional projection/fields. Read the full current objective before acting. |
| `create` | Required title/objective; optional kind, owner, participants, parent, dependencies, initial status/reason and progress. Defaults kind code, status open, owner yourself. |
| `update` | Current progress plus status/scope/reviewer/attention changes; optional revision guard. An agent update claims ownership unless it explicitly preserves the current owner. |
| `assign` | Required owner (yourself or a live descendant agent); changes ownership only, preserving status/progress. Naming the current owner changes nothing and succeeds with `unchanged: true`. |
| `handoff` | Optional target/reason: owner requests transfer to its immediate superior; default that superior, or user for a top-level owner. Ownership stays unchanged until assignment. Closed items cannot request handoff. |
| `participants` | Add/remove live collaborators using add/remove lists; changes access, not ownership. A request that changes nobody succeeds without writing (`unchanged: true`). |
| `evidence` | One kind/ref/note entry or items batch; add support without reopening closed work. |
| `accept` | Complete as done, preserving the locked progress lists; optional note appends completion evidence to done_so_far. Normal update claiming applies; use update with explicit owner to preserve someone else's ownership. |
| `archive` | Archive a closed done/superseded/dropped item early, retaining status. Open work or any pending attention source is refused. Already archived is a no-op. |
| `supersede` | Required by, an open replacement item you also manage; closes source as superseded, clears its manual flag. Self/replacement cycles and already-superseded source are refused. |
| `move` | Set parent to a readable parent item; omit parent to unnest. Cycles are refused. This is docket nesting, not an agent move. |
| `delete` | Remove the record from the docket and retire its slug permanently. User, owner's superior, or top-level owner only; sub-items and open linked questions prevent it. Prefer archive/dropped for history worth retaining. |

Owner, creator, their superiors, participants, named reviewer and user can read. Owner/creator/their superiors/user have management rights. Participants/reviewer can change state/progress and add evidence, including completion; retitling, re-scoping, assignment, participants and nesting require management rights. Top-level agents do not automatically manage every peer's item. Prior ownership alone is not retained access after reassignment.

**Projects.** Items do not attach to projects; `project` is refused. A project's docket lists the items owned by the agents under it, so to put an item there, give it an owner under the project. See [orgtree-projects](../../team/projects/SKILL.md).

An empty list can mean access is missing: ask the owner to add you as a participant rather than create a duplicate. Adding a participant grants item access, not a mail audience or access to that agent's other work. Participation notices are passive and reach-checked; inspect noticed/noticed_deferred/notice_refused results. A membership mutation may succeed even when its notice cannot be sent.

## Parameters by purpose

These are action-specific fields, not a universal object to pass on every call. Omitted update fields generally remain unchanged.

| Fields | Rules/defaults |
| --- | --- |
| `slug` | Fixed item name, required except list/create. Never use an agent name in its place. |
| `include_archived`, `include_backlogged` | list booleans, false by default. Their groups return under archived/backlogged, not mixed into items. |
| `projection` | summary/compact/full; list defaults summary, get defaults compact. Full get adds history/attachments. |
| `fields` | list/get explicit field selection; slug retained. This affects returned projection, not stored content. |
| `title` | create/update concrete title, at most 200 Unicode scalar characters; not an identity change. |
| `objective`, `objective_append` | create requires nonblank objective; update replaces it or appends text, mutually exclusive. No docket text truncation cap. |
| `kind` | create code/non-code (code default); evidence note/link/file/commit/log (note default). It is not a mail kind. |
| `owner` | create/assign chooses yourself or a live descendant agent; update names CURRENT holder to leave it with them or yourself to claim. On update, a name that is neither (for example a holder who has since changed) keeps the current holder, applies the rest and returns an "owner kept" note; it never moves the item. Use assign for a different new holder. |
| `reviewer` | update names another live agent; owner cannot review its own work. Reviewer receives access, not ownership. |
| `status` | See status table; create defaults open. Omitted update status retains it, except reopen defaults in_progress. |
| `blocked_reason`, `dropped_reason` | Required for the corresponding state, maximum 2,000/1,500 characters. Each clears on leaving that state. |
| `attention`, `attention_reason`, `attention_amend` | Manual user attention; true raises, false retracts, omitted preserves; amendment edits a standing flag. Reason max 1,500 characters. |
| `reopen` | update true resumes closed/archived work; false default. On open work it is ignored with a note, and the rest of the update applies. |
| `done_so_far`, `working_on_next` | Complete progress arrays, each at most 40 nonblank entries, each entry at most 500 characters (the schema states both limits). Keep both complete, either may be empty but not both. |
| `keep_done`, `keep_next` | update true keeps the corresponding stored list; no revision needed. |
| `done_append`, `next_append` | update adds to the corresponding stored list; no revision needed. An entry the list already holds is not added again (a retried append cannot duplicate it, and a note counts the skipped entries); the merged list must fit the limits. |
| `expected_rev` | update: optional guard. Against a newer item it refuses the whole call only when a field this call replaces changed after that revision: a whole progress list, the status or its reasons (reopen included), title/objective, reviewer, attention, or the ownership your update would claim. Appends, keeps, objective_append, evidence and participants never clash, so the update applies with an "applied over rev N" note. The refusal names the changed field; changes beyond the newest 32 revisions refuse as before. Also accepted by accept. |
| `participants` | create collaborators; owner is not duplicated here. Later edits use participants action. |
| `add`, `remove` | participants action lists; no ownership transfer or implicit reply audience. |
| `dependencies` | create other item slugs needed by this work; no automatic completion or landing proof. |
| `parent` | create/move parent item; omit on move to unnest. |
| `by` | supersede replacement slug; replacement must be open work with management rights. |
| `target`, `reason` | handoff recipient and why; target can only be immediate superior (user for top-level). Omitted reason uses an explanatory default. |
| `ref`, `note` | evidence path/URL/SHA/log reference (max 500 characters), and explanation; at least one nonblank. note on accept appends a progress entry within its limits. |
| `items` | evidence array of kind/ref/note objects, at most 50 total stored evidence rows after adding. |

## Scope and progress

The objective's first paragraph states the problem then briefly the solution; later paragraphs hold every requirement, default, exclusion, edge case and ruling. It is the standalone specification. Coordination mail, a notification excerpt and short progress lists do not replace it. Record new rulings there, with enough rationale that a successor does not re-argue them. Management updates may rewrite it but not empty it.

The stored progress lists are complete snapshots. Update at meaningful boundaries: scope decision, blocker, review request, delivery, pause or handoff. Distinguish implemented, committed, pushed, deployed, present in a build and behavior actually demonstrated. Never make a passing-build claim stand in for evidence of the requested behavior.

Read rev before using a patch:

```json
{"action":"update","slug":"example-work","owner":"current-owner","expected_rev":7,"keep_done":true,"working_on_next":["Check the revised draft against source."],"status":"in_progress"}
```

The example assumes the actual item read at revision 7: it keeps done_so_far and replaces working_on_next and the status, so it is refused only if working_on_next or the status changed after revision 7. Supplying a whole list and keep/append for that same list is refused. If the refusal names a changed field, read and reconcile before retrying. If a mutation timed out, re-read first: a lost response is not proof nothing was written.

Refusals point at the fix: a slug that names no item suggests the nearest live (unarchived) item you may read ("did you mean …?"; an item you may not read is never named), and an unreadable item says to ask the agent who gave you the slug, or to be added as a participant. (User 2026-10-27, from a survey of failed docket calls.)

**Omitting owner on your update takes the item.** Reviewers/participants must pass the current holder when preserving ownership. Assignment mail starts the new owner. Item-linked user replies default to the current manual-attention raiser when one exists, otherwise the owner; the user may choose another eligible recipient. Plain assign retains backlog status; staffing through [staff](../tool-staff/SKILL.md) or hire/rehire work_item opens the staffed backlog. A backlog assignment is not permission to start it.

## Statuses

| Status | Meaning |
| --- | --- |
| `backlogged` | Not approached/approved; outside active count, returned in its own optional group. Do not hide authorized incomplete work here. |
| `open` | Accepted/authorized, available to begin. |
| `in_progress` | Under way. |
| `blocked` | Requires what prevents progress, what unblocks it, who can act and how you hear of it. Stays active; idle docket reminders do not nudge it. Arrange a real message/watcher. |
| `review` | Agent review, name reviewer; owner retains the item. This is not a question to the user. |
| `approved` | Agent approval, not proof of landing. |
| `deploy_ready` | Complete, awaiting deployment; no implied deployment permission. |
| `done` | Objective actually complete; owner/participant can complete directly without a mandatory superior check. |
| `dropped` | Cancelled or irrecoverably failed; reason says which, who decided, what would justify resuming. Never success. |
| `superseded` | Replacement relationship established only by supersede action with by, not status on update. |

New items may start backlogged through deploy_ready, including approved, but never done/dropped/superseded. `waiting` is refused; use blocked. These are meanings, not a mandatory sequential pipeline. Use review only when another agent is actually checking; the named reviewer can approve/complete or request changes using in_progress and evidence.

## Questions and user attention

Ask a question through [orgtree_ask](../../user/tool-ask/SKILL.md), linking work_item on the question/tab. Answer mail returns to the asker. The item's separate Reply section offers the owner, participants and the current manual-attention raiser, defaulting to that raiser before the owner. A raiser who is also owner/participant keeps that existing role. Clearing the flag removes its extra recipient eligibility and restores the owner default. Sending to the raiser does not assign the item or grant docket access; the reply explicitly directs coordination with the owner. An attached open question contributes attention separately from a manual flag. Withdraw a stale question through [withdraw ask](../../user/tool-withdraw-ask/SKILL.md); clearing a flag or marking done does not answer it.

Raise attention only for a concrete non-question the user needs to see or confirm: a decision beyond scope, specialized edge case, definition filled on their behalf, or blocker not already covered by a question. The reason says what was asked, what was built/decided, the exact deviation and the requested confirmation. "Ready for review", a test report or generic "please approve" does not say that. Routine completion matching the requested scope needs no new acceptance round.

- Omission preserves the flag. Explicit attention false retracts it; take yours down when it stops mattering.
- attention_amend true refines the existing reason without a new raise; it needs a standing flag and cannot accompany attention true.
- Dismissal keeps done/review, otherwise blocks the item. An exact case/whitespace-normalized repeat of the latest dismissed reason is refused; cosmetic rewording is not material new information.
- A user reply via the docket clears manual attention when no linked question remains open. Read attention_sources/questions if the badge remains after a manual retraction.

## Evidence, archival and resumption

Evidence is a simple note/link/file/commit/log reference plus explanation, not a captured-git receipt or automatically checked claim. A file ref does not upload or deliver that file. Use [present](../../user/tool-present/SKILL.md) for material the user should read and [send file](../../user/tool-send-file/SKILL.md) for a file wanted as a file. Add evidence to closed work without reopening it.

Create currently admits at most 200 unarchived records, counting backlog and recently closed records too. Full get displays the latest 100 history entries; history projection is not the whole event store. Uploaded docket attachments have a 25 MiB per-file limit; upload is a separate UI/API operation, not an action of this tool. Bounded text/list/evidence overflow refuses the whole write rather than silently shortening it.

Done/superseded archive after an hour from docket activity; dropped archives immediately. A standing flag or linked open question delays automatic archival and keeps attention visible. Explicit archive requires a closed status and no attention. It cannot hide open work despite the short description "close early".

Resume the same slug with reopen true, current progress and a new status; omitted status defaults in_progress. The resumed work may already be finished when recorded, so reopen true plus done/dropped is permitted. To add only historical support, use evidence instead. Delete refuses attached open questions and child items, clears other items' dependency/replacement pointers with history, and retires the slug; do not use it as routine cleanup.

Retiring an owner does not finish its item. Abandoned-owner recovery can reassign unfinished stale work to a live top-level agent after at least 30 minutes, but is no substitute for a planned assignment/handoff.

## Minimal calls and retired interfaces

Read first:

```json
{"action":"list"}
```

Create one new item only when no existing item covers it:

```json
{"action":"create","title":"Check draft references","kind":"non-code","objective":"The draft contains references that have not been checked. Verify them against current source.\n\nRecord exact anchors and remaining limits.","working_on_next":["Read the referenced source files."]}
```

Legacy addendum, review/verdict/review-seat actions, receipts, artifacts, grants, findings, claims and acceptance-check actions are refused with a removed-interface explanation. Use evidence and ordinary review/approved/done statuses. An unknown action is also refused; do not copy 3.x workflows from stale documents.

## See also

- [orgtree-docket-items](../docket-items/SKILL.md)
- [orgtree-docket-statuses](../docket-statuses/SKILL.md)
- [orgtree-docket-review-and-attention](../docket-review-and-attention/SKILL.md)

For suggested team patterns, see `orgtree-committee-mode` and `orgtree-dev-team` (orgtree-workflows › collaboration-patterns).
