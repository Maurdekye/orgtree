# Orgtree 2.1.8

Most of this release is about agents that stop working and nobody finding out.
An agent could sit frozen for a day on a quota message that had stopped being
true; when an agent did stop, the person or agent responsible for it was told in
a way that never actually reached them; and the countdown meant to say when it
would resume reached zero early and then sat there.

The rest is the composer, the tray, and a set of tooltips that had grown into
paragraphs.

## Upgrading

The tray's **Update now** will offer this build to an existing installation.

## An out-of-date quota message no longer freezes an agent

An agent could sit frozen for hours on a quota error that had stopped being true
long before. The account had capacity, the credentials were fine, and other
agents on the same provider were working — but the coding tool kept returning
the same refusal, word for word, with the same countdown, for more than twenty
hours. Ten consecutive attempts received an identical message, including two
only seven minutes apart that both claimed the same time remaining. A countdown
that never counts down is not a live measurement, and the agent was being held
by an echo.

Orgtree already had a guard for exactly this: when a quota error arrives, check
it against the coding tool's own conversation history and cancel the freeze if
the error is historical rather than current.

**That guard had never once run.** It refused to read the conversation database
whenever a temporary sidecar file sat beside it — and the coding tool keeps that
sidecar open for the whole duration of a turn, which is precisely when the guard
is asked to run. Over six days it declined 108 times out of 108 and corrected
nothing. The code had no test coverage at all, which is how a safety net that
never caught anything stayed invisible.

The sidecar now chooses **how** to read rather than forbidding the read. With no
sidecar, the database is opened exactly as before. With one, it is opened
read-only in a single transaction, so every query sees one consistent committed
snapshot of a database another process is actively writing. Nothing is ever
written, and a database that cannot be read coherently still declines rather
than guessing — a failed read never invents a correction, so an agent that
genuinely should stay frozen does.

Detecting a real limit is untouched. An agent that hits a current wall still
freezes, and nothing runs past a live limit. What changed is only whether a
**stale** message counts as a live one.

This has since been confirmed on a live agent rather than only in tests. An
agent that had been re-freezing every five minutes for twenty-two hours was
released within four minutes of the fix going live, and completed a normal turn.

## An agent whose work stops now gets someone's attention

When an agent hit a provider usage limit, the agent responsible for it was told
by a message that did not wake them. They found out whenever they next happened
to run for some other reason — which could be hours, or never.

Two notifications were wrong this way: hitting a usage limit, and being parked
indefinitely. Both now wake the manager. The other three notifications in the
same family already did, and were left alone; being noisier was not the goal.
The existing limits on how often this can fire are kept, and one more was added,
so an agent that keeps hitting the same wall cannot wake its manager over and
over.

For a top-level agent the manager is **you**, and that notification was arriving
in your inbox already marked read — no unread badge, nothing to draw your eye.
You found out when you happened to look, which is the same failure the change
above exists to prevent. Those notifications now arrive unread. They do **not**
pulse your inbox; that signal is reserved for something genuinely needing you
immediately, and it only keeps working while it stays rare. Three purely
informational notifications were checked and deliberately left as they were.

## A released freeze no longer forgets what it was waiting for

When an agent's usage-limit freeze expired, the record of the wall it had hit
was deleted. If the agent then ran and hit the same wall moments later, nothing
was left to compare against, so a restated limit was treated as brand new and
the agent was frozen for the full period all over again. Worse, the recovery
path — the one that exists precisely to release an agent held on a stale
deadline — depended on evidence that this deletion had just destroyed, so it
could never run.

The wall's evidence now survives the release that clears the freeze, and is
forgotten when a turn genuinely completes, since a turn that ran means the limit
is no longer in force.

## The usage-limit countdown no longer reaches zero early

A frozen agent's countdown hit zero roughly a minute before the agent was
actually allowed to wake. The freeze was never stuck — the wake adds a short
grace period the displayed number did not account for, so the badge sat at zero
while nothing appeared to happen.

The badge now counts down **twice**, in sequence: first to the reset time the
provider itself stated, then a second short countdown to the moment the agent
can actually resume. Two honest numbers rather than one number quietly carrying
an allowance it never mentioned. The wake fires at exactly the same instant it
always did.

## Agents can move a stuck agent to an account with capacity

You have always been able to move a frozen agent onto a different provider
account and release it in one step. Agents managing other agents could not: the
two operations available to them refused each other, and releasing the freeze
without moving the account simply re-froze it seconds later on the same
exhausted account.

They now have the same single operation, and it runs the exact same code yours
does, so the two cannot drift apart. It checks that the destination account
actually has capacity first and refuses if it does not, rather than moving a
stuck agent somewhere equally stuck.

## Restart engine is always in the tray menu

The tray's **Restart engine** row used to appear only when the engine was
stopped or unavailable — so it could not be found in the ordinary case of a
healthy, running engine, which is the case you usually want it in.

The row is now present in every state and can be clicked while the engine is
running. It greys out only when a restart genuinely cannot be performed: during
startup, during a quit, while an update is installing, and while a restart is
already in flight.

Worth knowing before you use it: restarting a running engine ends the current
turn of every live agent, and that cannot be undone. There is deliberately no
confirmation prompt.

## The notice toggle is in every reply box

A **notice** is a message that lands in the recipient's mailbox and is read when
they next run, instead of waking them for it — the right shape for a heads-up
worth knowing but not worth interrupting anyone over.

That toggle now exists in the ticket reply, the mail reply and the presentation
reply as well as the main composer, and works the same way in all of them: it
sits above the attach button, **Alt+N** toggles it, a send that cannot be
delivered as a notice falls back to ordinary mail rather than failing, and a
sent notice is drawn with a dotted border. Each box remembers its own setting
and starts switched off; arming one does not arm another, and it disarms itself
once the message is sent.

The org-inbox compose modal is the one deliberate exception. It addresses
parties outside this organization, and a notice to an outside address is refused
by the server regardless — a control that could never do anything there would be
worse than no control.

When the composer is in notice mode its dashed edge follows the current
provider's colour, matching the edge that notice messages themselves wear.

## Smaller interface fixes

**The message box types from the top.** Text started part way down the box,
leaving a blank gap above the first line. The text area now sits at the top and
grows downward, so typing begins at the top whether the box is empty or already
expanded. The attach, notice and send buttons have not moved.

**One attachment icon everywhere.** The file-attachment button did not use the
same picture in every place you can attach a file, so the same action looked
like a different feature depending on which box you were in. Every attachment
control is now a paperclip, including the docket item's, which was text only.

**The attach button works in mail replies.** It was visible but permanently
greyed out, so a reply could not carry a file. The reply box enables attaching
only when it knows which organization the mail belongs to, and the one place
that renders a mail reply was not passing that along.

**The toolbar organization list draws one highlight per row.** Highlighting a
row split it into two blocks with a visible seam, which read as a rendering
fault — the highlight was painted on each cell rather than on the row. Each row
is now a single box with one wide rounded highlight across it.

## Tooltips that said too much

Three hovers had grown into panels and are now ordinary one-line tooltips.

The **account badge** showed six lines listing the account, provider, label,
email, sign-in state and standing. It now shows the account id and the email.

The **cache badge** could run to ten lines of explanation. It is now one short
line: a brief reason when the cache is not ready, or a simple confirmation with
a few words of context when it is.

The **MCP tool count** chip showed four lines — the current count, the count
from the last turn, which provider and code path produced the reading, and the
readiness state. It now reads `3 callable MCP tools`, with the readiness state
as a short trailing clause when there is one. The count line only repeated the
number printed on the chip an inch away.

In all three cases the badge itself — its symbol, its colour, its countdown —
is unchanged. Where a reading is unavailable, the tooltip still says why.
