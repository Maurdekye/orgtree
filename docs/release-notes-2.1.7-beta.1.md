# Orgtree 2.1.7-beta.1

The second beta of 2.1.7. Like the first, most of it is about the machinery
agents work through rather than the screen you look at — and this time almost
every fix came out of a trap that cost an agent real time while it was working
on something else.

Two of them are worth reading even if you skip the rest: a test run could pass
against code it was not testing, and removing a git worktree could delete the
repository it was linked to.

## Upgrading an existing installation

This is a prerelease. A stable installation ignores prereleases, so the tray's
**Update now** will not offer it — install this build by hand once. From then on
the installation sits on the `beta` line and receives later betas and the
eventual stable release automatically.

## A test run could pass without testing your code

On a machine with Orgtree installed, a test run started the ordinary way could
import the installed application instead of the working copy. It failed in both
directions and said nothing about either: a run could fail on code you had never
written, or — much worse — pass on shipped code that did not contain your change
at all. Nothing in the output distinguished the two.

The cause was Orgtree's own doing. It puts the installed application on the
import path when it starts an agent, which that agent needs in order to run at
all, and every command that agent starts inherits it.

Test modules now check where they imported the application from. If it came from
outside the working copy they stop immediately and say so, naming the path they
actually loaded, the copy they expected, and the exact command to run instead.
They refuse rather than quietly correcting the path, because a run repaired into
looking trustworthy is the same problem one step further along.

## Removing a worktree could delete the repository

A git worktree whose dependencies were linked back to the main checkout could
take that checkout with it when removed. This was already known for forced
removals; it turns out an ordinary removal does exactly the same thing, and an
ordinary removal is what people actually run, because the link leaves the
worktree looking clean.

Worktree removal now refuses whenever a link leaves the worktree, forced or not,
and names the way to clean it up safely. There is also a scan-and-clean command
for links that already exist, because refusing a removal does not disarm the ones
already on disk.

## Usage limits no longer strand an agent

Two faults, one visible symptom. An agent that hit a Claude session limit had its
turn ended outright instead of being frozen until the limit lifted, because the
step that records the limit could fail in a packaged build and take the freeze
with it. Separately, an agent frozen on a Gemini limit could stay frozen
indefinitely: each check re-read the same fixed countdown and pushed the release
time further out, so the deadline moved away as fast as the clock approached it.

Both are fixed. A limited agent freezes and recovers on its own.

## An archived agent no longer leaves its process running

Archiving an agent whose command-line process would not settle left that process
running. The archive now ends the process tree.

## Smaller fixes

- The reserve badge on an agent appears only when that agent is actually running
  on reserve capacity, instead of whenever it was the kind of agent that could.
  When the lane cannot be determined it shows nothing rather than guessing.
- The permission gate that blocks tool access to sensitive directories now says
  what it is. It covers nine directories, not the single one its error message
  implied, and the refusal names them.
- A queued notice drew its border and its kind marker twice.
- Notices in the transcript are drawn the way they were before the previous
  beta changed them.
- Amending a work item's acceptance conditions used to be accepted and silently
  discarded. It is now written and versioned, and any condition whose wording
  changed has its recorded evidence cleared, since that evidence was gathered
  for different words.
