# Orgtree 2.1.7-beta.3

A beta of 2.1.7 built for installation. This one is small and almost entirely
about the tools agents work through: two of them could report success for work
they had not actually done, and a third could block a release on a failure
nobody had caused.

## Upgrading an existing installation

This is a prerelease. A stable installation ignores prereleases, so the tray's
**Update now** will not offer it — install this build by hand once. From then on
the installation sits on the `beta` line and receives later betas and the
eventual stable release automatically.

## Two work-item actions now really do compare-and-set

`expected_rev` is how a caller says "apply this only if the item has not changed
since I read it". It is the difference between a refusal and two agents writing
over each other.

`check` and `accept` are the two actions that mutate the record deciding whether
an item is complete, and they were the two that took the argument and did
nothing with it. Both now honour it properly: the call is refused before
anything is written, naming both revisions, and it stays optional exactly as it
is elsewhere. On `check` the guard runs before the acceptance list is even read,
so a stale batch writes none of its elements rather than some of them.

The guard sits at `accept`'s own door rather than in the code it shares with a
reviewer's approval, so approving a review is unchanged.

## Release verification no longer blocks on failures you did not cause

The full verification profile ran the raw test command, which has no notion of a
test that was already failing before you arrived. One unowned failure anywhere
in the suite made every commit unverifiable, no matter what it touched.

Verification now compares against a recorded baseline: a failure that was
already there is acquitted by name, and a genuinely new one still blocks. Both
directions were demonstrated end to end before this shipped.

Two things were deliberately not done. A stale baseline is **refused** rather
than trusted, with its own exit code and a message that leads with "this is NOT
a failure of your change" — because the alternative is an agent hunting a
regression that does not exist. And an acquittal does not expire on a timer:
an expiry date would simply reintroduce the same blockage later, aimed at
whoever happened to commit next. Instead, every run that forgives an old failure
now says out loud how long it has been failing and whether anybody has ever been
handed it.

The verification also had to fit inside a time limit it was overrunning. It now
runs one gate per test suite instead of one command over all of them, which was
measured rather than guessed: the full profile completes in about two and a half
minutes.

## The composer looks like what it is about to do

Switching the message box into notice mode drew a hard solid outline, which read
as an error rather than as a mode. It now wears the same soft dashed edge that
notice messages themselves wear, in both light and dark themes.

The two surfaces are driven from the same two values rather than from matching
copies, so they cannot drift apart later, and the box does not change size or
shift its contents when you toggle the mode.
