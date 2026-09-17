# Orgtree 2.1.7-beta.0

The first beta of 2.1.7. Almost all of it is about the machinery agents work
through rather than the screen you look at: the docket, the work-item tools,
git worktrees, and the test suite. Sixteen reported problems are fixed, and
every one of them came out of agents describing what got in their way during
the 2.1.6 push.

Two changes are visible in the interface: a toggle beside the composer that
sends your next message as a passive notice, and model/provider/account
switching on a live agent that no longer strands the agent it was switching.

## Upgrading an existing installation

This is a prerelease. A stable 2.1.6 installation ignores prereleases, so the
tray's **Update now** will not offer it — install this build by hand once. From
then on the installation sits on the `beta` line and receives later betas and
the eventual stable release automatically.

## Send your next message as a passive notice

There is now a toggle beside the message composer. With it on, your next
message to an agent is delivered as a passive notice: it lands in that agent's
mailbox and is read at its next turn instead of waking it immediately. The
composer draws a dotted outline while the toggle is on, so the mode is visible
before you press send rather than after.

This is the thing you want for an FYI. Telling an agent "nice work" used to
cost it a full turn to receive and another to be polite back.

## Switching a live agent's model, provider or account is reliable

Rebinding a running agent to a different model, provider or account had six
separate defects, all of them fixed:

* A rebind issued while the agent was frozen by a usage limit is now refused
  outright, instead of leaving the agent stranded between two seats.
* An authentication freeze now thaws on the switch rather than surviving it.
* A rebind is guarded while work is genuinely in flight.
* The switch is announced, so a message dropped at the boundary is reported
  instead of vanishing quietly.
* A replay that crosses a thaw survives it, and the continuity narration tells
  you honestly what was and was not carried over.
* The rebind now goes through a single writer, which is what made the previous
  five reproducible in the first place.

## The docket

**A finished item can record what happened after it finished.** Marking an item
done used to lock it, so the commit that actually landed afterwards had nowhere
to go. A new `addendum` action amends a completed item without falsifying its
completion or wiping its acceptance record.

**Approving a review no longer closes the ticket before the code lands.** There
is a third review outcome, `approve_stage`, that accepts the work without
completing the item — the state you want between "this is right" and "this is
on main".

**An owner can name a peer as reviewer.** Review used to be reachable only
upward, which meant a coordinator reviewed everything or nothing did.

**Agents listed on an item can read its previous holders' work.** When an item
changes hands, the new holder can now read the scratch and transcript of the
agents who held it before — scoped to that item, not a general grant.

**Nothing is silently cut any more.** Every bounded field was audited against
what it actually promises. Over-length input is now refused with the submitted
length, the limit and the overage, rather than being quietly shortened. The
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

## Worktrees and the test suite

**Worktrees work out of the box.** Creating one needed a separate elevated write
to `.git`, which agents discovered by hitting the wall rather than by being told
about it. The wall is now named up front, a helper does the elevated step, and
the helper is deliberately hard to mistake for a way around the denial.

**The suite passes inside a worktree.** `engine/runtime` is now located by
searching upward, which restores ten tests that had been silently skipping in
every worktree.

**One renderer test run no longer balloons esbuild to 8–9 GB.** The bundle step
is batched and the esbuild service is stopped afterwards. The run costs about
eight seconds more when warm.

**A tripped run limit is loud.** This is the one worth reading twice. If the
renderer suite hit its run limit, whole batches of test files were dropped — and
the batches that had already finished left a "0 failures" summary on screen. A
run that never tested half its files was indistinguishable from a clean one. The
runner now names both numbers: `RUN INCOMPLETE: 175 of 234 test files never ran
to completion`. This was reproduced deliberately before it was fixed.

**There is a shared baseline of known failures.** Every agent used to stand up a
second worktree at the base commit and run the whole suite twice, about twenty
minutes each, just to learn which failures were already there. Eleven agents
described doing exactly that. `tools/test-baseline.mjs compare` now answers it
from a recorded baseline, splitting new failures from pre-existing ones, and
there is a handover ledger for passing a pre-existing failure to whoever owns it
without claiming it yourself.

**An agent's own scratch folder is writable.** The read-only carve was denying
agents write access to their own working folder.

## Known failures in this build

Measuring the baseline turned up **13 pre-existing failures in the Python
backend suite** on `main`. They are not regressions from this work — they are
present in 2.1.6 as well, and nobody had measured them before, which is the
whole reason the baseline ticket existed. They are recorded in
`docs/known-failures.md` with a handover entry each, and they are not fixed
here.

The node and renderer suites are green: 637 of 638 and 2097 of 2097. The single
node failure is a known pre-existing one.
