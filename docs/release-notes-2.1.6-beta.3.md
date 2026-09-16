# Orgtree 2.1.6-beta.3

This beta makes the interface keep up with a busy organization. Streamed agent
output was costing the renderer roughly ten times more memory than it needed
and leaving the desk up to twenty seconds behind the agent it was showing; both
are fixed. A renderer that does fail now recovers itself instead of asking you
to restart, and says why. It also carries the earlier 2.1.6 fixes: the crash
when expanding a question answer, the installer refusing an upgrade over
unrelated programs, and agents whose conversation file had moved.

## Upgrading an existing installation

This is a prerelease. A stable 2.1.5 installation ignores prereleases, so the
tray's **Update now** will not offer it — install this build by hand once. From
then on the installation sits on the `beta` line and receives later betas and
the eventual stable release automatically.

## Mail hub startup

The packaged embedded Python runtime did not name the hub's own directory on its
import path, so the mail hub could not start in an installed build — the
embedded interpreter reads its search path from a `._pth` file and ignores
`PYTHONPATH` entirely, which is exactly the case the layout checks did not
cover. The path file now names the hub directory, and the packaging checks fail
closed rather than producing a build whose hub cannot start.

## The mail hub is now its own product

The mail hub that lets organizations reach each other has been taken out of
Orgtree and pinned as a separate repository, `orgtree-mailhub`. Orgtree tracks
an exact commit of it rather than carrying its own copy, so the hub can be
fixed and released on its own schedule without a desktop release.

Every hub-facing surface in the interface has been rebuilt on the hub's own
model rather than on the shape the old built-in hub happened to have.

## Promoting an agent moves its whole team

Self-subjugation — inserting an agent above another — is now a single atomic
subtree promotion. The promoted agent takes its position with its entire team
underneath it, and the move either happens completely or not at all.

A promotion also keeps both team charters instead of dropping one of them. The
standing instructions the promoted agent gave its own team, and the ones it now
inherits, both survive the move.

## Mail tells you what actually happened

When mail is addressed to a node that cannot receive it, the sender is now told
what really happened rather than being left to infer it from silence.

## Questions and the docket

- Question cards are rendered as sanitized Markdown, so a question written with
  headings, lists or code in it reads as intended instead of as raw text. The
  same rendering covers option labels and descriptions.
- Long docket tickets collapse their detail sections, so a ticket with a large
  description no longer pushes everything else off the panel.
- The attention dismiss control now sits beside the attention block it applies
  to, rather than somewhere the block does not explain.
- Staffing an item with Quick Staff notifies the agent that previously held it,
  and only when the staffing actually succeeded.
- A question attached to a docket item raises one notification instead of
  several.

## Interface

- A collapsed hire's expanded token list draws in the right layer instead of
  behind what it should sit above.
- Narrow modal lists collapse into overlay panels rather than being squeezed
  into a column too narrow to read.
- The unhovered model icon at far zoom is larger and better spaced.
- The tray offers a **Restart engine** entry when the engine has stopped, so a
  stopped engine can be brought back without restarting the application.

## Stability

- The fold store no longer loops forever. Its sweep removed keys after every
  render while the fold effect added them back on every store change, and a
  fold whose key set only partly matched the census could keep the two fighting
  until React gave up — an infinite re-render that took the interface down. The
  two halves now settle instead of undoing each other.
- The docket description compares a fold measurement before storing it, in one
  place shared by both surfaces that measure folds. Writing an unchanged
  measurement back from a resize observer is the same feedback loop by another
  route, and only one of the two surfaces was guarding against it.

## Automatic compaction

Automatic cache-protective compaction was refusing to run for exactly the
agents it exists for. It consulted the agent's own last reported status and
skipped anything that had said it was blocked — but at the point the decision
is made, that status is always the *previous* turn's report, because the
current turn has not replaced it yet. An agent that asked a question, reported
blocked, went quiet past its cache lifetime and then woke on the answer was
never compacted.

The decision is now made on the session rather than on a status word.

A question an agent has asked you also survives being compacted. Compaction
used to discard the agent's open request, which meant a question could vanish
off your screen without you or the agent closing it; the question now carries
across to the replacement session, and the replacement is told it inherited
one. Answering still wakes the agent and still lets it compact.
## Expanding a question answer no longer kills the desk

Clicking a question answer in an agent's chat transcript could take the whole
desk down instantly — a blank error boundary where the conversation was. It
happened only when that agent was **working at the time**, which is why it
looked random.

The transcript re-measures its own layout after every render, and that
measurement almost always comes back the same. It was written to skip the
update when the value had not changed, and that is where the mistake was:
skipping the change stops the redraw, but the update is still handed to React,
and React only discards it when the component has nothing else in flight. A
streaming agent always has something in flight. So the measurement scheduled a
render, the render re-took the measurement, and the two fed each other until
React gave up. Opening the answer was simply what started it.

The measurement is now compared before it is submitted rather than after, so an
unchanged value is not submitted at all.

## Installing an update no longer blames unrelated programs

An upgrade could refuse to proceed, reporting that processes were "still running
from the installation folder" and naming programs that had nothing to do with
Orgtree — the Windows Command Palette, Copilot, browser components. Retrying
usually worked, which made it look like a glitch.

Windows keeps a record of each process's parent even after that parent has
exited, and the parent's id is then free to be reused by something unrelated.
The installer followed those records to decide what belonged to Orgtree, and so
adopted whole unrelated families of processes. It now checks that a claimed
parent actually started before its child, which a reused id cannot fake.

## Agents whose conversation file moved can be woken again

A Codex agent whose stored conversation path no longer matched where its file
actually lived could never take another turn: every wake failed immediately.
Worse, the failed lookup also put the agent into a held state, which stopped it
receiving mail as well.

A resume now retries without the stale path when the refusal is about the path,
and a conversation that has moved is located rather than given up on. A resume
that genuinely cannot be resolved now says what it looked for and where, instead
of naming only an identifier.

## Streamed output no longer buries the renderer

Every token an agent streamed went to the interface as its own update, and each
one cost far more than the token itself — the transcript re-measured and
re-rendered, and the draft's text was re-parsed as Markdown from scratch each
time. On a busy organization the interface allocated tens of megabytes per
second to display a few kilobytes of output, and fell further behind the longer
it ran.

Live text now reaches the screen once per frame instead of once per token.
Measured on the same workload: **332 MB down to 33 MB** for 960 tokens, and the
desk's lag behind the agent it is showing went from a median of **20.2 seconds
to 24 milliseconds**. Streaming still looks live — it is the same text at the
same speed, drawn once per frame rather than once per token.

An honest limit: this removes a real and measured cost, but whether it is
enough on its own to stop a renderer being killed outright under heavy load is
not established. Most of that process's memory sits outside the part this
change affects.

## A window that dies now comes back

If the interface process fails, Orgtree reloads the window instead of telling
you to restart the whole application — the engine and your agents were never
affected, and now neither is your place in the interface. Repeated failures
fall back to the old dialog rather than looping, and that dialog now carries the
reason it failed.

Failures are also recorded. Previously a renderer that was killed left no crash
dump, no system event and no log line of any kind, which made this class of
problem nearly impossible to investigate. Orgtree now writes the reason and exit
code to its own log, and crash dumps are collected **locally only** — nothing is
uploaded, and there is a tray entry to reach a dump deliberately if you want to
send one.

## Restart no longer leaves a wall of raw text

A turn interrupted by a restart was replayed to the agent with its whole
envelope re-sent as plain text, which appeared in the chat as an unformatted
block — and stacked another one on every further restart. The replay now carries
its original formatting, collapses instead of accumulating, and says plainly
that it is a resumed turn. What the agent receives is unchanged.
