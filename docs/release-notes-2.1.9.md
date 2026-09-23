# Orgtree 2.1.9

This release is about the interface staying usable while agents actually work.
On a large organization, reading anything used to cost as much as reading
everything, every write stood in one queue behind every other write, and the
person watching paid for it: inboxes that timed out, saves that took ten
seconds, halts that took a minute. 2.1.9 reworks how organization state is
read and written, then stabilizes the management operations around it.

It arrives through four betas — beta.0 through beta.3 — that were each
measured against a copy of the real organization that surfaced the problem,
and then validated live. This stable build is byte-for-byte the proven beta.3
contents; only the version and these notes differ.

## Upgrading

The tray's **Update now** will offer this build to an existing installation.
Existing betas on the 2.1.9 line update to it as well.

## Reading one thing no longer costs reading everything

Every read of the organization used to build the entire organization in
memory first. Every write did that twice — parsed everything to change one
field, then re-serialized everything to work out what changed — and every
write in the whole program queued behind a single lock while it did. On a
101 MB organization that meant roughly eleven megabytes parsed and eleven
re-serialized for a six-kilobyte change.

Now a read costs what it reads, a write re-serializes only what it touched,
and the document stays resident between writes instead of being rebuilt each
time. The organization tree no longer re-parses the document at all: it
rebuilds from a shared snapshot refreshed by exactly what each save changed,
and a rebuild parses zero bytes of it (a test counts).

The interface converges by arithmetic instead of refetching: every update the
server pushes carries a sequence number, every full tree states which updates
it already includes, and a gap in the numbers triggers exactly one catch-up
fetch.

Measured live on this organization, under an eight-agent working load,
against the same operations on 2.1.8-era builds: common reads three to four
times faster (p50 roughly 350–470 ms against 1.5 s), agent status writes
eighteen times faster (p50 124 ms against 2.3 s, worst case 1.5 s against
14 s), and about 1,300 consecutive live calls with zero failures. Uncontended,
a tree read costs about 2 ms and an ordinary write about 11 ms.

## Halting or resuming a group is one operation

Halt and unhalt accept a list of agents: one permission check, every target's
process interrupted up front so they terminate in parallel, and per-agent
results. A halt that used to take 66 seconds for a wave of agents takes about
three. Halting an agent is also now a confirmed kill — the operation reports
when the process is actually gone, not merely asked to leave.

## Changing a busy agent's account now queues

Changing the account or model of an agent that is mid-turn no longer fails or
tangles with a queued model switch. The requests queue per agent, apply in
acceptance order at the turn boundary, compose correctly with a queued switch
(including across providers), and an agent whose account change lands while
it is frozen on an exhausted account is woken exactly once. This area
received four review rounds and a 39-test reliability suite before landing.

## Management fixes from across the beta line

- **The whole interface no longer freezes while one agent is being managed**,
  and a restart no longer strands agents it never got round to.
- **A window that loses the engine comes back by itself**, and the window
  controls stay visible on error and holding screens, so a stranded view can
  always be closed, minimized, or refreshed. Refreshing a stranded view
  restarts Orgtree cleanly instead of silently doing nothing.
- **Quick Staffing can suggest an account** for the requested tier when the
  option is switched on (it is off by default); the receiving agent keeps its
  staffing authority and the suggestion is carried, not imposed.
- **Attention flags behave like records**: an agent can take back its own
  flag without destroying the ticket, answering a flag no longer deletes the
  question, and an unrelated edit no longer takes down a flag the user is
  still reading.
- **Ticket descriptions no longer get corrupted**, and reassigning a ticket
  no longer starts work that was left deliberately unstarted.
- **The full agent menu is available from every view**, the message box
  remembers what you sent, and right-click works in text fields.
- **Codex CLI can run against OpenRouter** as a backend.
- **Every slow request explains itself**: any request over half a second
  leaves a durable trace with a stage breakdown and an explicit unattributed
  remainder, so a slow moment can be diagnosed from the build itself.

## What still is not fast

Honesty about the remainder: under heavy many-agent load, the full
organization view and some saves can still take multiple seconds — the
residual cost sits in building and serializing the full tree, not in the
storage fixes above. That remainder is measured, traced, and is the subject
of a full state-system rearchitecture currently in design. It ships when it
is proven, not before.

## The numbers, and how to read them

The headline figures above were measured live on the organization that
surfaced the problem, under a real working load, and the earlier bench
figures they confirmed were measured against a 101 MB copy through the real
API. They are strong evidence, not a guarantee for every organization shape;
the slow-request tracing in this build is the instrument that decides any
disagreement.
