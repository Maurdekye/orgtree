# Orgtree 2.1.9-beta.0

Most of this release is about work that quietly stopped and nobody being able to
restart it. An agent that ran out of quota could not be moved to an account that
had room, even when one was sitting there unused. The whole interface could
freeze while a single agent was being managed. And a window that lost its
connection stayed blank until you quit and reopened the app.

The rest is the message box, right-click in text fields, and a set of ticket
behaviours that did more than they were asked to.

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

## You can move a stuck agent to an account that has room again

An agent that hits its quota freezes. If another signed-in account for the same
provider had room, the agent's right-click menu was supposed to offer
**Continue on \<account\>** — move it there and release the freeze in one step.

That entry never appeared. Not for some agents, or in some states: it could not
appear at all, for any agent, on any account.

The menu itself was fine. The problem was the test behind it, which asked "has
this account proved it has room?" and treated every answer it could not
establish as a "no". A usage window that has not started yet does not report a
reset time, so an account sitting at **zero percent used** was read as full. On
a machine where one account was exhausted and the other was untouched, neither
qualified, the menu had nothing to list, and the only way to move an agent was
to stop it, release it and reassign its account by hand, one command at a time.

The manual action now asks the opposite question — is there anything that
positively says this account is full? An account is offered unless a usage
window actually reports 100%, or Orgtree has recorded a limit on it that has not
expired. If the evidence is merely missing or unreadable, that is not a reason
to hide an account from you; you can see the usage board, and you are choosing
on purpose.

The automatic side is deliberately unchanged. When you switch on automatic
account fallback, Orgtree moves an agent with nobody watching, and for that it
still requires positive proof of capacity before it acts. The two paths now ask
different questions on purpose, and both still respect a limit Orgtree has
already recorded.

## An agent can take back an attention flag without destroying the ticket

When an agent raised a flag asking you to look at something, and then worked out
the answer itself, it had no way to take the flag down. The only route available
would have reopened the ticket, which erases its acceptance record — so agents
left stale flags standing rather than lose the record of what had been checked.

A finished ticket's flag can now be withdrawn on its own. The ticket's status,
its acceptance record, its evidence and both progress lists are untouched, and
the withdrawal is written into the ticket's history with the reason for it, so
you can tell a question being taken back from a flag that vanished by accident.

This matters more than it sounds: a ticket holding a flag can never archive, so
one stale flag kept a finished ticket on your active list permanently.

## Answering a flag no longer deletes the question you answered

Replying to an attention flag cleared it and discarded the text of the question
at the same time, so the ticket's history recorded that something had been
answered without recording what. Every route that clears a flag now keeps the
flag's own text, and a reply keeps your answer beside it.

## An unrelated edit no longer takes down a question you are reading

When an agent raised an attention flag, **any** later update to that ticket
cleared it — including one that had nothing to do with the flag. An agent
fixing a ticket's title silently dropped the question you were still reading,
and neither of you would necessarily notice.

An update that does not mention the flag now leaves it alone. Three things take
one down deliberately: you replying to it, you dismissing it, or the agent
explicitly retracting it. Superseding a ticket also clears its flag — that is
the ticket being replaced rather than edited, and leaving the question standing
would print a dead question above its live replacement.

The consequence worth knowing is that **retraction is now the raising agent's
job**. A flag that stops mattering — because the agent worked the answer out
itself, or the question became moot — will sit on your screen until that agent
takes it down, since nothing else will do it any more. The agent-facing
instructions were updated to say so.

## The whole interface no longer freezes while one agent is being managed

Eighteen operations — reassigning an agent, changing its settings, and others —
held the engine's document lock on the main event loop while they read and wrote
to disk. For as long as one of them was waiting, **every other request and every
live update, for every agent, waited with it.** One slow operation stopped the
whole interface, not just the thing you clicked.

Measured with two real operations doing identical work, differing only in how
they were declared: an unrelated request that took 27 milliseconds during one
took 3,376 milliseconds during the other. Those eighteen now do their disk work
off the event loop.

Honesty about what this does and does not fix: this removes a real freeze that
was reproduced and eliminated. It was measured at sixteen busy agents, which is
heavier than this machine normally runs, so it is not a promise that a
day-to-day delay disappears.

Two smaller versions of the same problem were fixed alongside it: streaming text
and the agent tool-call path both did more shared-lock work per message than
they needed to.

## A restart no longer strands agents it never got round to

When Orgtree restarts, it picks up the agents whose turn was cut off and resumes
them. It did that by first clearing the "this agent was mid-turn" marker from
**every** agent at once and saving that to disk, then resuming them one at a
time. The marker was only put back if the process survived to the end.

So if the engine was killed partway through — which is exactly what happens
during a crash, a forced restart, or an update — every agent it had not reached
yet lost its marker permanently. No later restart replayed them. And because
that same marker is what would have revealed them as stuck, they showed as
**idle** rather than stranded: work that had quietly stopped, looking like work
that had finished.

Each marker is now cleared immediately before that agent is resumed, rather than
all of them up front, so no outcome depends on the restart running to
completion. A kill at any point can now lose at most the one agent being resumed
at that instant, and every other agent is either still marked or already
replayed.

This was reproduced deliberately rather than reasoned about: the process is
hard-killed mid-way through, at three different points, with a matched control
at each that lets the process live. Before the fix, an agent the loop had not
reached lost its marker and was never replayed. After it, it is replayed.

**One deliberate exception, chosen by you.** If a restart finds that an agent
has *already started a newer turn*, the older interrupted turn is now dropped
instead of being queued behind it. What that loses is the interrupted turn's own
prompt text, which exists nowhere else — a real loss, and the one you chose over
having stale work run after newer work. What it does **not** lose is the agent's
mail: that lives in the mailbox rather than in the marker, and the newer turn
already running picks it up. The log now says which of the two happened rather
than just "dropping the interrupted turn", which could be read either way.

## A window that loses the engine comes back by itself

The main window's contents are served by the engine. If the engine stopped at
the wrong moment — during a reload, for instance — the window was left with
nothing to draw and nothing to draw it from, and it stayed blank until you quit
and relaunched. Nothing was watching for a failed load and nothing retried.

A window whose document fails to load now retries, and re-navigates once a
healthy engine is listening again.

## The message box remembers what you sent

There was no way back to something you had already sent to an agent: you found
it in the transcript and copied it out by hand.

**Up** and **Down** now walk through what you have sent to that agent, the way a
terminal does. The history is kept per agent, survives a restart, and is capped.
Recall restores the text only.

This replaces the older, separate rescue route for drafts lost when an agent's
identity changed — the "Older unsent drafts" panel and its copy button are gone,
and a stranded draft is now written straight into that history where **Up**
reaches it like anything else. It applies to the main message box, not to reply
boxes.

## Right-click works in text fields

Right-clicking any text box in Orgtree produced no menu at all — no cut, no
copy, no paste. Every text field now has one, including in popped-out windows,
where it appears in the window you actually clicked in.

## Ticket descriptions no longer get corrupted

Ticket descriptions could arrive holding fragments of an agent's own tool-call
markup — a stray closing tag followed by the raw contents of whatever the agent
was writing next. The result was unreadable text in the middle of a
specification you were supposed to be able to trust.

New descriptions carrying that markup are now refused outright rather than
stored. For descriptions already damaged, there is a repair tool that reports by
default and only writes when explicitly told to. It will not guess: a repair is
applied only when putting the removed text back reproduces the stored version
exactly, character for character. Anything it cannot reconstruct that certainly
is left alone, because re-typing a specification to fix an encoding fault risks
silently changing what it says.

## Reassigning a ticket no longer starts work you left unstarted

Handing a ticket to a different agent also switched it from "not started" to
"open", so a ticket you had deliberately left in the backlog began counting as
active work the moment someone was assigned to it. You asked for one field to
change and two changed. Ownership and status are separate things, and a plain
assignment now changes only ownership — a backlogged ticket stays backlogged.

The deliberate exceptions are the paths that **start an agent working on the
ticket** in the same action: staffing, and hiring an agent with a ticket
attached. Those create the seat and set the agent going, so leaving the ticket
"not started" would have the docket reporting work as unstarted while an agent
was visibly running it. If you want an assignment to open the ticket as well,
say so by setting its status.

This reverses a behaviour introduced in 2.1.0 and described in its release
notes. Those notes are historical and have deliberately been left as they were.

## Smaller fixes

**The App settings window no longer has a stray close button** under every tab.
Escape, a click outside it, and the title bar's right-click menu all still close
it.

**Opening a presented document no longer fights the canvas.** Clicking through
to a document as the view was still settling could leave the camera in the wrong
place; the two no longer race.

**The ticket list is faster to open** when an organization has a large archive.
Counting archived tickets no longer builds the whole archive first, and a
section nobody asked for is no longer assembled.
