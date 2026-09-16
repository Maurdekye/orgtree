# Orgtree 2.1.6

The stable release of the 2.1.6 line. It is a large one: the mail hub that lets
organizations reach each other has become its own product, promoting an agent
now carries its whole team with it, mail says what actually happened to it, the
renderer keeps up with a busy organization instead of falling behind it, and a
window that dies now comes back by itself.

Alongside those, this release fixes the faults that made the previous version
tiring to use: a crash when expanding a question answer, an installer that
refused an upgrade and blamed unrelated programs, agents whose conversation file
had moved and could not be woken, an answered question card that reappeared
after a restart, and a work item description that could freeze the panel it was
in. The rest is interface work — the agent desk's panels, the docket's sections,
and the badges on the chart.

## Upgrading an existing installation

The tray's **Update now** offers this release to any 2.1.5 or later
installation, and installations already on the `beta` line receive it the same
way. Nothing needs to be installed by hand.

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

## An answered question no longer comes back after a restart

An answered question could reappear in the chat pane as a full-size card after
a restart — the whole question body, the code block, the `answered` chip and
the answer as its last line — taking roughly a screenful of scrollback and
sitting between you and your conversation until it eventually cleared on its
own.

It cleared after fifteen minutes. That was the whole of it: a timer, not an
event, which is why there was never anything you could point at as the thing
that finally dismissed it.

The desk deliberately holds a just-answered question on screen for a short
while, so the answer has one visible representation until the answer itself
appears in the transcript. That hold was measured purely in wall-clock time, so
it outlived the process that started it. A restart reloads the page, the fresh
page has no record that the answer was already shown, and it cannot re-derive
one from a transcript that no longer contains the pre-restart answer — so the
card re-pinned itself and stayed.

The hold is now bounded by the current session as well as by the clock: a
question answered before this session began is not one this session needs to
hand over. The card is collapsed, not erased — the answered question keeps its
place in your inbox exactly as before, and an answer genuinely still in flight
at restart falls back to its own bubble rather than vanishing.

## A work item's description can no longer freeze

Once a work item had accumulated a hundred revisions of its description, that
description could never be changed again — and no decision could be recorded on
it either. All three routes passed through the same limit and all three were
refused.

The refusal named a remedy: consolidate the settled rulings into the
description. That remedy was itself one of the refused operations. An agent
following the instruction it had just been given received the same error a
second time, and there was no way out from inside the tool.

Past the limit, the oldest revisions now roll over into an archive that has no
limit of its own. This is not truncation and not summarising — a rolled-over
revision keeps its number, its timestamp, its author, its complete before-and-
after text and its links to the revisions it replaced. Nothing is discarded, so
the guarantee the history exists for is intact, and raising the number would
only have moved the day the problem arrived.

The second half matters more day to day. An item whose description has stopped
being the complete story now **says so where the description is read**, not
only when a write fails. The notice appears above the description in the docket
pane, travels with the item when it is handed to another agent, and
distinguishes two genuinely different situations: a description that is simply
partial because part of its history has moved to the archive, and one that is
incomplete because rulings made while the item was frozen were never recorded
at all and cannot be recovered.

## The agent desk's document panel is the right way round

The zoomed-in agent desk's presented-documents tab split its panel backwards:
the list of document titles took just over half the width, and the document
itself was left the narrower half. That proportion had been borrowed from the
docket tab beside it, where it is correct for a different reason — a docket row
is a name you read in the list, whereas a presentation row is a title you click
to open something, and the something is the half that has to be readable.

The tab now uses the same rule its own popped-out and pinned panel already
used, rather than carrying a second copy of the number. The document gets
roughly two thirds. The docket and inbox tabs were measured and left alone;
neither had the problem.

## Pin, pop out and open as a modal, from the desk itself

The presented-documents, docket and inbox tabs of the agent desk each gain
three buttons in their corner:

- **Pin** pins that tab's panel, exactly as the pin in a panel's title bar does.
- **Pop out** opens that tab's panel as its own window.
- **Open as a modal** opens that tab full-size, the same view you get from the
  agent's right-click menu.

Each button acts on that tab's own view — the docket button pins the docket,
the inbox button pins the inbox — and each one runs the same code the existing
route already ran rather than a second implementation of it. The buttons appear
only on the desk's tabs, never inside the modal they open, which already has a
pin and a pop-out in its title bar.

## The collapsed list rail's button fits its rail

When a mail or presentation panel is narrow enough for its list to collapse, the
list becomes a thin rail with a single button in it. That button was wider than
the rail — it stuck out over the panel beside it, and the overhang was visible on
one side only because the panel clipped the other.

The button had asked for a size that would have fitted. The request never took
effect: a broader rule covering buttons inside panels outranked it, and nothing
in the layout noticed. The button is now sized from the rail's own published
width instead of from a number typed next to it, so no future styling rule can
push it back out.

Both surfaces that collapse — the inbox and presented documents — had this, and
both are fixed. The docket panel does not collapse at all, so it never had it.

## The model badge's letter grows with the badge

The tier badge on an unhovered agent at far zoom is larger in this release, and
the letter inside it had kept its old size. The badge grew by half
again; the letter grew by about a quarter. The result read as a larger ring
around the same small character rather than as a larger badge.

The letter now scales by the same proportion as the badge it sits in. The
hovered and closer-zoom states are unchanged.

## Acceptance conditions and verification start closed

A ticket's **acceptance conditions** and **verification** sections now begin
collapsed every time the ticket is opened, rather than only the first time. They
expand by hand exactly as before; only the starting state has changed, and no
other section on the ticket is affected.

The distinction matters in practice: a section you expanded yesterday opens
closed again today. Expanding one and reopening the ticket returns it to closed
rather than remembering the posture you left it in.
