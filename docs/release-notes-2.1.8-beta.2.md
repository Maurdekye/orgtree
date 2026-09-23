# Orgtree 2.1.8-beta.2

One fix, and it is the important half of a problem 2.1.8-beta.0 only half
solved: an agent can no longer be frozen by a usage-limit message that is no
longer true.

## Upgrading an existing installation

This is a prerelease. A stable installation ignores prereleases, so the tray's
**Update now** will not offer it — install this build by hand once. From then on
the installation sits on the `beta` line and receives later betas and the
eventual stable release automatically.

## An out-of-date quota message no longer freezes an agent

An Antigravity agent could sit frozen for hours on a quota error that had
stopped being true long before. The account had capacity, the credentials were
fine, and other agents on the same provider were working — but the coding tool
kept returning the same refusal, word for word, with the same countdown, for
more than twenty hours. Ten consecutive attempts received an identical message,
including two attempts only seven minutes apart that both claimed the same time
remaining. A countdown that never counts down is not a live measurement, and the
agent was being held by an echo.

Orgtree already had a guard for exactly this. When a quota error arrives, it is
supposed to check that error against the coding tool's own conversation history
and cancel the freeze if the error is historical rather than current.

**That guard had never once run.** It refused to read the conversation database
whenever a temporary sidecar file sat beside it — and the coding tool keeps that
sidecar open for the whole duration of a turn, which is precisely when the guard
is asked to run. Over six days it declined 108 times out of 108 and corrected
nothing. The module had no test coverage at all, which is how a safety net that
never caught anything stayed invisible.

The sidecar now chooses **how** to read rather than forbidding the read. With no
sidecar, the database is opened exactly as before. With one, it is opened
read-only in a single transaction, so every query sees one consistent committed
snapshot of a database another process is actively writing. Nothing is ever
written, and a database that cannot be read coherently still declines rather
than guessing — a failed read never invents a correction, so an agent that
genuinely should stay frozen does.

Two supporting changes come with it. Declines now record **why** they declined
rather than collapsing every cause into one unhelpful label, so a real failure
can be told apart from the ordinary case. And the module now has tests: 12 of
them, covering both directions, including controls that prove a genuine current
limit still freezes the agent.

## What this does not change

Detecting a real limit is untouched. An agent that hits a current wall still
freezes, and nothing runs past a live limit. This build changes only whether a
**stale** message counts as a live one.

The five-minute retry behaviour added in 2.1.8-beta.0 also stays. It remains the
correct backstop for a limit message that genuinely cannot be classified.

## Known issue, not fixed in this build

A usage-limit countdown still reaches zero about a minute before the agent is
actually allowed to wake: the wake adds a grace period that the displayed
countdown does not. The freeze is not stuck — it releases a minute later than
the number suggests. A fix is on the docket.
