# Orgtree 2.1.8-beta.0

A small beta. Three interface corrections you can see, and one fix to how a
usage-limited agent recovers.

## Upgrading an existing installation

This is a prerelease. A stable installation ignores prereleases, so the tray's
**Update now** will not offer it — install this build by hand once. From then on
the installation sits on the `beta` line and receives later betas and the
eventual stable release automatically.

## The toolbar organization list draws one highlight per row

Highlighting a row in the toolbar's organization list split it into two blocks
with a visible seam, which read as a rendering fault. The cause was that the
highlight was painted on each cell rather than on the row, and the cells were
centred rather than stretched — so an organization with no activity had a short
stub of highlight beside a full-height one.

Each row is now a single box, and its highlight is one wide rounded rectangle
across the whole row. The columns still line up with each other, and the row
height is unchanged, so the popup is sized exactly as before.

## The notice toggle sits above the file upload button

It was beside it; it is now above it, in a stack with the attach button. What
the toggle does is unchanged.

One consequence worth knowing, because it is visible: two stacked round buttons
are taller than an empty two-line message box, so the composer is about 13
pixels taller when it is completely empty. The extra height goes away as soon as
you type enough to grow the text area. Nothing moves sideways, nothing overlaps,
and neither button changed size.

## The notice-mode outline is provider-coloured again

Switching the composer into notice mode draws a dashed edge, matching the edge
on notice messages themselves. That dashed treatment stays, but it had also
taken a neutral grey colour along with it. The outline now follows the current
provider's colour again while keeping the dashed style, and the two surfaces
still share that style so they cannot drift apart.

Notice messages in the transcript are unchanged.

## A released freeze no longer forgets what it was waiting for

When an agent's usage-limit freeze expired, the record of the wall it had hit
was deleted. If the agent then ran and hit the same wall moments later, nothing
was left to compare against, so a restated limit was treated as a brand new one
and the agent was frozen for the full period all over again.

Worse, the recovery path — the one that exists precisely to release an agent
that is being held on a stale deadline — depended on evidence that this deletion
had just destroyed, so it could never actually run.

The wall's evidence now survives the release that clears the freeze, and is
forgotten when a turn genuinely completes, since a turn that ran means the limit
is no longer in force. Detecting a limit was not touched: agents still freeze
when they should, and nothing runs past a live wall.
