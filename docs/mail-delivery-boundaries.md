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

## Long managed tools and opaque provider tools

The agent API gives `orgtree_staff`, `orgtree_hire`, `orgtree_rehire`,
`orgtree_retire`, `orgtree_dissolve`, `orgtree_cheap_compact`,
`orgtree_watchdog`, and `orgtree_send_file` a ten-second synchronous wait.
After that wait, a still-running operation returns `state: running` and an
`operation_id`. This is an actual tool result, creating the usual safe
delivery boundary. It is explicitly **not** a success/completion result.
The backend worker continues independently of the agent's turn and sends
the eventual outcome as durable mail. Quick calls retain their original
result and do not send a duplicate completion message. Authentication is
checked before registration and again at execution; normal tool authority
and admission gates remain in the dispatcher.

Before execution, the backend records the operation identity in
`<data-root>/tool-waits.db`, using a separate SQLite transaction so a tool
holding the org document lock cannot prevent the HTTP wait from yielding.
There are at most eight executing workers and 64 unresolved records;
capacity refusal occurs before execution. The ten-second bound is the
execution wait, excluding authentication and durable-storage admission.
Completion persistence is retried without reexecuting the operation.
Publication stores the mail and its deduplication marker in the same org
transaction, then retires the operation journal record. Caller seat identity
follows rename and compaction but does not hand private results to a later
hire that reused the name. A missing recipient leaves the result retained.

At restart, unresolved running operations produce an **unknown outcome**
message. They are never automatically restarted: their effects may already
have happened. Existing operation receipts and actual org state must resolve
that uncertainty before a caller repeats an action. Completed yielded
operations retry publication. Recovery rotates through at most 32 records
per pass; it uses the existing durable mail drain and respects holds.

Orgtree cannot safely yield a provider-owned/native/external tool for which
the protocol exposes no such operation. Codex's separate steer pump requests
input every two seconds while tools run; hook-based transports have their
next-boundary request queued in the engine. A request does not promise model
visibility before a non-interruptible tool returns. No tool is cancelled or
repeated to make a boundary. Each pump fetch is capped at 32 FIFO carriers.

Delivery labels now distinguish engine-queued input, a steering request in
flight, provider acceptance into the running process, and a hook injection
recorded by the CLI. Provider acceptance alone is **not** a model-read receipt.
Only actual matching Codex tool-result events update its observed boundary
clock; pump polling and steering acknowledgments do not. The earlier
provider-consumed-before-durable-receipt ambiguity above is unchanged.

`tests/test_long_tool_mail.py` covers the adapter, HTTP identity checks,
single execution, durable completion/retry, restart uncertainty, compaction,
holds, bounded admission, FIFO and truthful receipts. The explicit
`tests/long-tool-mail-probe.py 130` uses a 130-second controlled staffing
dispatcher and a provider-boundary seam: the previous route holds three
user messages until the tool returns, while the new route yields at about
ten seconds and exposes them in order. It never calls a live provider or
performs live staffing.
