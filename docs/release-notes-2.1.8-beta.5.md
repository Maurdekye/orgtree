# Orgtree 2.1.8-beta.5

Four changes on top of beta.4. Two are about what the app tells you when an
agent stops working; two are about tooltips saying less.

## Upgrading an existing installation

This is a prerelease. A stable installation ignores prereleases, so the tray's
**Update now** will not offer it — install this build by hand once. From then on
the installation sits on the `beta` line and receives later betas and the
eventual stable release automatically.

## An agent whose work stops now actually gets someone's attention

When an agent hit a provider usage limit, its manager was told by a message that
did not wake them. The manager found out whenever they next happened to run for
some other reason — which could be hours, or never. Tonight it was ten minutes,
and only because a person noticed first and said so.

Two of these notifications were wrong: hitting a usage limit, and being parked
indefinitely. Both now wake the manager. The other three notifications in the
same family already did, and were left alone — being noisier was not the goal.

The existing limits on how often this can fire are kept, and a further one was
added, so an agent that keeps hitting the same wall cannot wake its manager over
and over.

## The same message now arrives unread for you

The fix above covers agents whose manager is another agent. For a top-level
agent, the manager is **you** — and that notification was arriving in your inbox
already marked read, so no unread badge appeared and nothing drew your eye to
it. You found out when you happened to look, which is the same failure the
change above exists to prevent.

Those notifications now arrive unread. They do **not** pulse your inbox — that
signal is reserved for something genuinely needing you immediately, and it only
keeps working while it stays rare. Three notifications that are purely
informational were checked and deliberately left as they were.

## Agents can move a stuck agent to an account with capacity

You have always been able to move a frozen agent onto a different provider
account and release it in one step. Agents managing other agents could not: the
two operations they had available refused each other, and releasing the freeze
without moving the account simply re-froze it seconds later on the same
exhausted account.

They now have the same single operation, and it runs the exact same code yours
does, so the two cannot drift apart and start behaving differently. It checks
that the destination account actually has capacity first and refuses if it does
not, rather than moving a stuck agent somewhere equally stuck.

## Two tooltips that said too much

The account badge showed a six-line hover panel listing the account, provider,
label, email, sign-in state and standing. It is now an ordinary tooltip with the
account id and the email, and nothing else.

The cache badge's tooltip could run to ten lines of explanation. It is now one
short line: a brief reason when the cache is not ready, or a simple confirmation
with a few words of context when it is. Every reason the app can report has its
own short phrase. The badge itself — its symbol, its colour and its countdown —
is unchanged.
