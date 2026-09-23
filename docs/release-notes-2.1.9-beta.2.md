# Orgtree 2.1.9-beta.2

beta.1 answered half the question. Under your real eight-agent swarm it never
hung, never lost anything, and never needed a restart — the beta.0 failure was
gone — but it was not *usable*: a settings save took ten seconds, and agents
you had just resumed sat on screen looking halted for over a minute. You
concluded the worst issues remained, and you were right. This build is aimed
at exactly those two remainders, with the causes measured first and each fix
carrying a test that fails without it.

## Installing this build

**This is a prerelease and it is not published to the update channel, so the
tray's Update now will not offer it.** You install it by running the installer
file you were sent, by hand.

The installer closes Orgtree and waits for every agent to stop before it
replaces any files. It does not force anything — it waits — but every agent's
current turn ends, and that cannot be undone. Pick a moment when losing
in-flight work is acceptable.

Nothing was published, installed, restarted or shut down in producing this
build.

## Why beta.1 was still slow, in one paragraph

The writes themselves were already fast — about six milliseconds. What made
everything feel slow was the *demand* around them: every save invalidated the
org tree, so the tree was re-parsed and re-rendered constantly (about a tenth
of a second of interpreter-held work each time, multiplied by every save and
every open window), and all of that shared one Python interpreter with your
writes. A write that needed six milliseconds sat behind seconds of other
people's rendering. Separately, the UI was throwing away trees it had already
fetched whenever a live update raced them — under a busy swarm that race was
lost every time, so the screen starved and showed minute-old lifecycle state
while the backend was already correct.

## What actually changed

- **The tree no longer re-parses the document.** It rebuilds from a shared
  snapshot that refreshes from exactly what each save changed. A rebuild now
  parses zero bytes of the document (a test counts), and serving an unchanged
  tree costs about two milliseconds.
- **The UI converges by arithmetic instead of guessing.** Every update the
  server pushes carries a sequence number, and every full tree states which
  updates it already includes. The UI applies every fetched tree and replays
  only the newer patches on top; a gap in the numbers triggers exactly one
  catch-up fetch. The starvation mechanism is gone at the source, with
  reordering and gap tests.
- **Halting or resuming a group is one operation.** Halt and unhalt accept a
  list: one permission check, every target's process interrupted up front so
  they terminate in parallel, per-agent results. Resuming a wave no longer
  queues N full-price calls, and halting one no longer waits serially while
  siblings' processes are still running. The halt wait-loop also no longer
  hammers the write lock while it waits — that alone was most of your
  66-second halt.
- **Every slow request now explains itself.** Any request over half a second
  leaves a durable trace with a full stage breakdown — including time lost to
  interpreter contention, which the old timers could not see, and an explicit
  "unattributed" remainder. If anything is still slow in your retest, the
  build itself says where. (`/api/diagnostics/slow-requests`, kept bounded,
  never containing message content or paths.)

## The numbers

Measured against a copy of your organization through the real API, by the
agent that did the work, using the same script and snapshot as every previous
comparison. The middle column is what the live wave-2 swarm measured on
beta.1; the right column is this build under the same eight-writer shape:

- Agent write, 8 concurrent: p50 2251 ms → **167 ms**; worst 14.2 s → **325 ms**
- Saving agent settings under load: you observed ~10 s → **p50 225 ms**
- Marking mail read under load: **171 ms**
- Throughput: 43 operations per second, zero errors, zero reachability gaps
- Uncontended: tree 1.7 ms, inbox 5.5 ms, write 11 ms, settings 26 ms

**Treat these as what they are.** The synthetic writers do not run real agent
turns, which add their own compute — live numbers will sit above bench
numbers. One known remainder is stated plainly: under an artificial 43
saves-per-second hammer, tree rebuilds still cost ~0.9 s each; real swarms
save a few times per second, and the next optimization for that case is
designed and deliberately not rushed into this build. Your retest is what
decides, and per your ruling the next step if this build misses is a fully
instrumented live test — the tracing in this build is that instrument.
