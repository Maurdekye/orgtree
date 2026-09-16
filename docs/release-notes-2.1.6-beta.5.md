# Orgtree 2.1.6-beta.5

A short beta of three interface corrections, all of them reported from looking at
the previous build rather than found in testing. A button in the collapsed list
rail no longer overflows the rail it sits in, the model badge's letter now grows
with the badge around it, and a ticket's acceptance conditions and verification
sections start closed.

It carries everything from the earlier 2.1.6 betas: the answered question card
that came back after a restart, the work item description that could freeze, the
streamed-output memory and latency fixes, renderer crash recovery, the crash when
expanding a question answer, the installer refusing an upgrade over unrelated
programs, and agents whose conversation file had moved.

## Upgrading an existing installation

This is a prerelease. A stable 2.1.5 installation ignores prereleases, so the
tray's **Update now** will not offer it — install this build by hand once. From
then on the installation sits on the `beta` line and receives later betas and
the eventual stable release automatically.

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

The tier badge on an unhovered agent at far zoom was enlarged in an earlier
2.1.6 beta, but the letter inside it kept its old size. The badge grew by half
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
