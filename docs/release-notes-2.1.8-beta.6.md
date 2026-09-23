# Orgtree 2.1.8-beta.6

Two changes on top of beta.5. One is a tooltip saying less; the other is a
repository tool that was reporting success for work it had not done.

## Upgrading an existing installation

This is a prerelease. A stable installation ignores prereleases, so the tray's
**Update now** will not offer it — install this build by hand once. From then on
the installation sits on the `beta` line and receives later betas and the
eventual stable release automatically.

## The MCP tool count tooltip is one line instead of four

The `MCP 3` chip beside an agent showed a four-line hover: the current callable
tool count, the count from the last successful turn, which provider and code
path produced the reading, and the readiness state. It is now a single line —
`3 callable MCP tools`, with the readiness state added as a short trailing
clause when there is one.

Three of the four lines went. The count line only repeated the number already
printed on the chip an inch away. `last successful turn: none` said the same
nothing as the `—` the chip shows in that state. The provider and code path
identified which part of the app produced the reading, which is a question for
somebody debugging the app rather than a hover hint.

Two things were deliberately kept. When the count is unknown, the tooltip still
says **why** — a blank "unknown" was a complaint that produced an earlier fix,
and dropping the reason would have walked straight back into it. And a reading
carried over from a previous turn now says "last turn" in words rather than
relying on the `~` prefix alone, which costs two words and removes the need to
know what the symbol means.

The chip itself is untouched: the same number, the same `~` prefix, the same
four colour states, changing at exactly the same moments.

## A test tool that reported "no new failures" for tests it never ran

This one is not part of the app — it is `tools/test-baseline.mjs` in the
repository, the tool every agent here uses to prove a change broke nothing. It
is in this release because the fix is in the same commit history, not because
anything in the installed build changes.

Asking it for a suite by a name that does not exist — `--suite node` instead of
`node-root` — made it run nothing at all and then print **`VERDICT: no new
failures`** and exit successfully. A typo produced a clean bill of health, and
the only hint was the absence of output that should have been there. An agent
nearly quoted one of these as evidence that its change was safe.

An unrecognised suite name is now refused outright, with a nonzero exit, the
list of real names, and a suggestion when the name is close to one of them. No
verdict line is printed at all, because a verdict about tests that did not run
is the whole defect.

The general form is fixed too, not just the typo: any comparison that ends up
running **zero** suites — for any reason — now refuses instead of falling
through to a pass. And the verdict line states its own coverage, so a run
covering one suite can no longer be quoted as if it covered the repository.

One related discovery, recorded rather than acted on: the tool's
`--concurrency` setting never reached the Python test runner, which is
sequential by design. The setting was accepted everywhere and written into the
saved baseline as though it had described the run. It no longer claims to do
something it does not do.
