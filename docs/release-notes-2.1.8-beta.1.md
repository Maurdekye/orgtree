# Orgtree 2.1.8-beta.1

A very small beta on top of 2.1.8-beta.0. Two interface corrections, both of
them things the previous beta got slightly wrong.

## Upgrading an existing installation

This is a prerelease. A stable installation ignores prereleases, so the tray's
**Update now** will not offer it — install this build by hand once. From then on
the installation sits on the `beta` line and receives later betas and the
eventual stable release automatically.

If you are already on 2.1.8-beta.0 you are on the `beta` line already.

## Restart engine is always in the tray menu

The tray menu's **Restart engine** row used to appear only when the engine was
stopped or unavailable. That meant it could not be found in the ordinary case —
a healthy, running engine — which is the case you usually want it in.

The row is now present in every state, and it can be clicked while the engine is
running. It greys out only when a restart genuinely cannot be performed: during
startup before there is anything to restart, during a quit, while an update is
being installed, and while a restart is already in flight. The label still reads
**Restarting engine...** while one is under way.

Worth knowing before you use it: restarting a running engine ends the current
turn of every live agent, and that cannot be undone. There is deliberately no
confirmation prompt — the row behaves the same way whether the engine is up or
down. What a restart actually does is unchanged.

## The message box types from the top again

Text typed into a desk's message box started part way down the box rather than
at its top, leaving a blank gap above the first line.

This was a side effect of moving the notice toggle above the attach button in
2.1.8-beta.0. Those two stacked round buttons are 52 pixels tall while an empty
two-line message box is about 39, and everything in that row sat on the bottom
edge — so the text area was pushed down by the difference and the gap opened
above it. It closed on its own as soon as you typed enough to grow the box,
which is why it read as text sitting low rather than as a fixed misalignment.

The text area now sits at the top of the box and grows downward, so typing
begins at the top whether the box is empty or already expanded. The attach
button, the notice toggle and the send button have not moved — they still sit on
the bottom edge of the box exactly as they did.

The previous beta's release notes described that extra height as a visible
consequence of the toggle move. This is the correction to it.
