# Durable delivery at turn boundaries

Queued mail has two independent pieces of state. The mailbox and `delivering`
journal own its content. A node's `mail_drain` record names the message IDs that
an accepted waking send still requires the engine to deliver. Clearing the
current `inflight` turn cannot clear that remaining demand.

The normal send path still injects mail during a safe tool boundary or feeds it
at a result boundary. A worker's outer cleanup releases its own runtime claim
even if an inner finalizer raises after taking the next queue entry. It cannot
release a newer worker's reservation. Remaining demand wakes an independent
consumer, which repairs unowned journals and re-enters ordinary turn admission.
It neither needs a second message nor depends on a chat read or a UI refresh.

## Ordering and receipts

Mail pointers record the IDs they were created for. An obsolete pointer cannot
take unrelated newer mail ahead of an older journaled carrier. A carrier that
already owns a journal batch delivers that batch before taking newer boxed mail.
Recovery reconstructs pure mail pointers from durable content, while retaining
self-contained carriers and their original replay context.

Confirmed IDs retire in the same save as the delivery receipt. If that save
fails, the live process retains the confirmation and retries the save before
folding the batch back. Confirmed batches are not replayed at restart. Pending
IDs belong to the successor through normal compaction, cheap compaction, and
session replacement; archived predecessors do not inherit them.

The existing provider receipt contract remains in force. A provider may consume
a message and then crash before an authoritative receipt becomes durable. The
engine cannot distinguish that case from non-consumption. Existing ambiguous
steer/restart recovery can therefore replay the message and reports that
uncertainty. This change guarantees no duplicate delivery for known confirmed
batches; it does not establish end-to-end exactly-once processing across that
ambiguous provider window.

## Bounds and holds

The consumer maintains an index of pending seats, reconstructed on startup.
It visits at most 32 seats per pass, rotating busy and held seats behind others.
An event prompts a pass after sends and worker completion; a one-second tick
services remaining work and failed repairs without scanning archived nodes on
every tick. Failed discovery is retried. Unexpected worker or thread-admission
failure records an exponential retry deadline capped at 30 seconds.

An ordinary worker hands remaining carriers to a fresh worker after 32 queue
entries, including empty pointers. The Claude result-boundary feed likewise
stops after 32 entries and returns remaining work through ordinary admission.
Each new turn still takes the shared turn slot and checks the existing gates.

Passive notices never create waking demand. Frozen, remote-controlled, native
context, import recovery, storage, spending, and non-live holds remain effective.
Halt and killswitch latch suspend existing demand; releasing them alone does
not start a turn. A later waking send can rearm it. A terminal provider failure
retires that attempt's demand while retaining newer queued sends.

A one-time upgrade adopts legacy waking mail, so existing stranded messages do
not need a new send just to create their first demand record. It excludes legacy
terminal failures and preserves halt/killswitch suspension.

## Regressions

`tests/test_mail_drain.py` exercises tool-call arrival with no subsequent nudge,
actual turn-finalizer failure after the next carrier was popped, final-boundary
arrival, restart with and without an in-flight marker, confirmed restart
delivery, both compaction paths, interruption, ordering across obsolete pointers
and journals, partial delivery and storage failures, thread-admission retry,
bounded nested work and round-robin recovery, passive mail, holds, and upgrade
adoption. Provider responses are controlled at the provider seam; these tests
do not spend subscription capacity or send live messages.
