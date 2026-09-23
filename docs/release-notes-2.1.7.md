# Orgtree 2.1.7

Almost all of this release is about the machinery agents work through rather
than the screen you look at: the docket, the work-item tools, git worktrees,
usage limits, and the test suite. Nearly every fix in it came out of an agent
describing what got in its way while it was trying to do something else.

Three are worth reading even if you skip the rest. A test run could pass against
code it was not testing. Removing a git worktree could delete the repository it
was linked to. And a work item could be completed with nothing checked at all.

Two changes are visible in the interface: a toggle beside the composer that
sends your next message as a passive notice, and switching a live agent's model,
provider or account, which no longer strands the agent it was switching.

## Upgrading

The tray's **Update now** will offer this build to an existing installation.

## Send your next message as a passive notice

There is now a toggle beside the message composer. With it on, your next message
to an agent is delivered as a passive notice: it lands in that agent's mailbox
and is read at its next turn instead of waking it immediately. The composer
takes on the same soft dashed edge that notice messages wear, so the mode is
visible before you press send rather than after.

This is the thing you want for an FYI. Telling an agent "nice work" used to cost
it a full turn to receive and another to be polite back.

`Alt+N` toggles it. It disarms when you send and at no other time — not when you
press Escape, not when you clear the text, not when you switch recipient. If the
recipient cannot take a notice, the message is sent as an ordinary one rather
than failing. In the transcript, only messages actually delivered as a notice
carry the notice edge.

## Switching a live agent's model, provider or account is reliable

Rebinding a running agent had six separate defects, all of them fixed:

* A rebind issued while the agent was frozen by a usage limit is now refused
  outright, instead of leaving the agent stranded between two seats.
* An authentication freeze now thaws on the switch rather than surviving it.
* A rebind is guarded while work is genuinely in flight.
* The switch is announced, so a message dropped at the boundary is reported
  instead of vanishing quietly.
* A replay that crosses a thaw survives it, and the continuity narration says
  honestly what was and was not carried over.
* The rebind goes through a single writer, which is what made the previous five
  reproducible in the first place.

## Usage limits no longer strand an agent

Two faults with one visible symptom. An agent that hit a Claude session limit
had its turn ended outright instead of being frozen until the limit lifted,
because the step that records the limit could fail in a packaged build and take
the freeze with it. Separately, an agent frozen on a Gemini limit could stay
frozen indefinitely: each check re-read the same fixed countdown and pushed the
release time further out, so the deadline moved away as fast as the clock
approached it.

Both are fixed. A limited agent freezes and recovers on its own.

The reserve badge on an agent now appears only when that agent is actually
running on reserve capacity, rather than whenever it was the kind of agent that
could be. When the lane cannot be determined it shows nothing instead of
guessing.

## A test run could pass without testing your code

On a machine with Orgtree installed, a test run started the ordinary way could
import the installed application instead of the working copy. It failed in both
directions and said nothing about either: a run could fail on code you had never
written, or — much worse — pass on shipped code that did not contain your change
at all. Nothing in the output distinguished the two.

The cause was Orgtree's own doing. It puts the installed application on the
import path when it starts an agent, which that agent needs in order to run at
all, and every command that agent starts inherits it.

Test modules now check where they imported the application from. If it came from
outside the working copy they stop immediately and say so, naming the path they
actually loaded, the copy they expected, and the exact command to run instead.
They refuse rather than quietly correcting the path, because a run repaired into
looking trustworthy is the same problem one step further along.

## Removing a worktree could delete the repository

A git worktree whose dependencies were linked back to the main checkout could
take that checkout with it when removed. This was already known for forced
removals; it turns out an ordinary removal does exactly the same thing, and an
ordinary removal is what people actually run, because the link leaves the
worktree looking clean.

Worktree removal now refuses whenever a link leaves the worktree, forced or not,
and names the way to clean it up safely. There is also a scan-and-clean command
for links that already exist, because refusing a removal does not disarm the
ones already on disk.

## A work item could be completed with nothing checked

Completing an item recorded the completion whether or not its acceptance
conditions had been checked, so an item could reach Done carrying no evidence at
all and read exactly like one that had been verified. The gate now records an
unclassified completion instead of letting it pass silently, and the invariants
are pinned so no later ruling can quietly relax them.

## The docket

**A finished item can record what happened after it finished.** Marking an item
done used to lock it, so the commit that actually landed afterwards had nowhere
to go. A new `addendum` action amends a completed item without falsifying its
completion or wiping its acceptance record.

**Approving a review no longer closes the ticket before the code lands.** There
is a third review outcome, `approve_stage`, that accepts the work without
completing the item — the state you want between "this is right" and "this is on
main".

**An owner can ask for a peer as reviewer.** Review used to be reachable only
upward, which meant a coordinator reviewed everything or nothing did. An owner
now requests the review seat, and the request is routed to the nearest agent
with the standing to grant it.

**Agents listed on an item can read its previous holders' work.** When an item
changes hands, the new holder can read the scratch and transcript of the agents
who held it before — scoped to that item, not a general grant.

**Amending acceptance conditions works.** It used to be accepted and silently
discarded. Conditions are now written and versioned, and any condition whose
wording changed has its recorded evidence cleared, since that evidence was
gathered for different words.

**Two actions now really do compare-and-set.** `check` and `accept` are the
actions that mutate the record deciding whether an item is complete, and they
were taking the "only if unchanged" argument and ignoring it. Both honour it
now, refusing before anything is written and naming both revisions.

**Arguments that do nothing are refused rather than dropped.** An action that
does not read an argument now says so instead of accepting the call, advancing
the revision and quietly discarding it. The agents who followed the
documentation are the ones who were affected, which is why this is a refusal and
not a silent correction.

**Nothing is silently cut.** Every bounded field was audited against what it
actually promises. Over-length input is refused with the submitted length, the
limit and the overage, rather than being quietly shortened, and the fields whose
briefs ask for several substantive things were given room to hold them. The
dismissed-attention reason was being dropped entirely; it is kept.

**`get` and `list` return payloads you can actually read.** Both grew a compact
projection, and the docket stopped serving its own record twice inside the same
response.

**Smaller tool corrections.** `update` no longer demands both progress lists
when you are only appending to one, and `keep_done` composes with `done_append`
instead of conflicting with it. `check` and `evidence` report every validation
fault in a batch at once instead of one per round trip. A `fields` caller can
ask for `ref` by name.

**The landing slot on `main` is a mechanism.** Coordinating who merges next used
to be a convention passed around in mail. It is a lease now.

## Worktrees, permissions and the test suite

**Worktrees work out of the box.** Creating one needed a separate elevated write
to `.git`, which agents discovered by hitting the wall rather than by being told
about it. The wall is named up front now, a helper does the elevated step, and
the helper is deliberately hard to mistake for a way around the denial.

**The sensitive-path gate says what it is.** The refusal named a single
directory; the gate actually covers nine, and it sits above the permission
system, where a headless turn has nobody available to answer the approval it
raises. Agents are now told this before they meet it, including what does and
does not clear it.

**An agent's own scratch folder is writable.** The read-only carve was denying
agents write access to their own working folder.

**The suite passes inside a worktree.** `engine/runtime` is located by searching
upward, which restores ten tests that had been silently skipping in every
worktree.

**One renderer test run no longer balloons esbuild to 8–9 GB.** The bundle step
is batched and the esbuild service is stopped afterwards. The run costs about
eight seconds more when warm.

**A tripped run limit is loud.** This one is worth reading twice. If the renderer
suite hit its run limit, whole batches of test files were dropped — and the
batches that had already finished left a "0 failures" summary on screen. A run
that never tested half its files was indistinguishable from a clean one. The
runner names both numbers now: `RUN INCOMPLETE: 175 of 234 test files never ran
to completion`. This was reproduced deliberately before it was fixed.

**There is a shared baseline of known failures.** Every agent used to stand up a
second worktree at the base commit and run the whole suite twice, about twenty
minutes each, just to learn which failures were already there. Eleven agents
described doing exactly that. A baseline tool answers it from a recorded run,
splitting new failures from pre-existing ones, and there is a handover ledger for
passing a pre-existing failure to whoever owns it without claiming it yourself.

**Release verification no longer blocks on failures you did not cause.** The full
verification profile ran the raw test command, which has no notion of a test that
was already failing before you arrived, so one unowned failure made every commit
unverifiable no matter what it touched. Verification now compares against the
baseline: a failure that was already there is acquitted by name, and a genuinely
new one still blocks.

Two deliberate choices inside that. A stale baseline is refused rather than
trusted, with its own exit code and a message that leads with "this is NOT a
failure of your change" — because the alternative is somebody hunting a
regression that does not exist. And an acquittal does not expire on a timer,
since an expiry date would simply reintroduce the same blockage later, aimed at
whoever happened to commit next. Instead, every run that forgives an old failure
says how long it has been failing and whether anybody has ever been handed it.

**An archived agent no longer leaves its process running.** Archiving an agent
whose command-line process would not settle left that process behind. The archive
ends the process tree.

## Known failures in this release

Measuring the baseline turned up **13 pre-existing failures in the Python backend
suite**. They are not regressions from this work — they are present in 2.1.6 as
well, and nobody had measured them before, which is the whole reason the baseline
work existed. They are recorded in `docs/known-failures.md` with a handover entry
each, and they are not fixed here.

The node and renderer suites are green.
