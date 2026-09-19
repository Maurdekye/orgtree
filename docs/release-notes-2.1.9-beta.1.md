# Orgtree 2.1.9-beta.1

This build exists for one reason: so you can find out whether the slowness is
actually fixed.

It contains the state-access rearchitecture and almost nothing else. You asked
for a beta you could run under real concurrent-agent load to decide whether that
direction was worth pursuing — this is that beta. It is a prototype, built
straight from `main` the moment the work landed, and it deliberately does not
wait for the other paused tickets.

## Installing this build

**This is a prerelease and it is not published to the update channel, so the
tray's Update now will not offer it.** You install it by running the installer
file you were sent, by hand.

Worth knowing before you start it: the installer closes Orgtree and waits for
every agent to stop before it replaces any files. It does not force anything —
it waits — but every agent's current turn ends, and that cannot be undone. Pick
a moment when losing in-flight work is acceptable.

Nothing was published, installed, restarted or shut down in producing this
build.

## What actually changed

Every read of the organization used to build the entire organization in memory
first. Reading one agent's name cost the same as reading all of it. Every write
did the same thing twice — it read all of it to change one field, then
re-serialized all of it to work out what had changed — and every write in the
whole program queued behind a single lock while it did.

On your organization that meant roughly eleven megabytes parsed and eleven
megabytes re-serialized for a six-kilobyte change, about a third of a second per
write, with everything else waiting. That is what you were experiencing as
Signal timing out while opening an inbox, answering a question, marking mail
read, or saving an agent's settings. It was never really those features being
slow. They were all standing in the same queue.

Now a read costs what it reads, and a write re-serializes only what it touched.
The document stays resident between writes instead of being rebuilt each time,
so a warm write parses nothing at all.

## The numbers

These were measured by the agent that did the work, against a copy of your own
organization at 101 MB, driven through the real API rather than through test
helpers:

- Agent write: 331.9 ms → 13.9 ms
- Saving agent settings: 207.6 ms → 29.6 ms, and 1503 ms → 115 ms under load
- Marking mail read under load: 867 ms → 76 ms
- Eight concurrent writers: 3.15 → 31.6 operations per second
- Under the concurrency where a send previously became unavailable for minutes:
  sends now complete in roughly two thirds of a second

**Treat these as what they are.** They were measured on a copy, with a synthetic
load, by the agent that wrote the change. They are a strong reason to expect
improvement, not proof that your experience improves. Your retest is what
decides that — which is the whole point of shipping you this build.

## Consistency was not traded away for this

A reasonable worry about a change like this is that it bought speed by allowing
things to be briefly wrong — a message that looks sent but is not, two agents
spending the same credits, a notice delivered twice.

That is not what happened here, and it was checked rather than asserted. Writes
are still strictly serialized, and the guarantees that prevent lost updates,
duplicate delivery and half-applied changes are unchanged. The speed came from
not doing unnecessary work, not from relaxing any of those rules.

As the reviewer I tested this the only way worth trusting: by deliberately
breaking the code and confirming the safety tests noticed. I made a change
vanish silently — the exact failure this design could have introduced, where a
write is made but never actually saved — and the test suite caught it. I did
that on three separate versions of the work, and it was caught every time.

## If something still looks slow

There is a new diagnostics endpoint, `/api/diagnostics/state-access`, which
breaks down where time actually goes per operation: lock waiting and holding,
loads, saves with the exact set of things that changed, and phase timers. If
something still feels slow during your retest, that is the thing to read — it
will say which part is responsible instead of leaving it to guesswork.

There is also an escape hatch. Setting `ORGTREE_SCOPED_SAVE=0` restores the old
full compare-on-save behaviour, so if you ever suspect the new save path, you
can turn it off without going back to an older build.

## Known limits of this build

- It is a prototype for measurement. Some further optimization work is designed
  but deliberately not built, because whether it is needed depends on what your
  retest shows.
- The performance figures above are the implementer's measurements on a copy of
  your organization, not measurements of your live system.
- One narrow edge case is documented in the code rather than fixed: an abandoned
  change to a rarely-touched section can, under a specific timing overlap,
  survive until the next save instead of being discarded immediately. It cannot
  lose data, and it is written down where the next person to touch that code
  will see it.
