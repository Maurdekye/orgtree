# Orgtree 2.1.6-beta.0

This is the first beta of 2.1.6. It replaces the built-in mail hub with a
separate product, makes promoting an agent move its whole team in one piece,
and fixes two render loops that could take the interface down.

## Upgrading an existing installation

This is a prerelease. A stable 2.1.5 installation ignores prereleases, so the
tray's **Update now** will not offer it — install this build by hand once. From
then on the installation sits on the `beta` line and receives later betas and
the eventual stable release automatically.

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

## Known limitations

The interface crash reported when expanding a question answer in the desk's
chat transcript is still under investigation and is **not** fixed in this
build. The two render-loop fixes above are real and are in the same family of
defect, but neither has been tied to that specific crash.
