## Orgtree 2.0.7

This patch release repairs quitting and restarting the app, recovers turns that a restart interrupted, and fixes several canvas and history display problems.

- Quitting Orgtree from the tray now stops the engine the app is attached to, including one started at boot. Before this, Quit left the engine running in the background and only restarting the PC ended it.
- Restarting from inside the app now actually restarts. The window used to come back attached to the very same engine process, so a restart the app had authorised changed nothing.
- Agents no longer sit at "starting..." after a restart that did not happen, and a turn waiting on one can now be stopped with the pause control.
- Resumes a turn the engine's restart interrupted, per agent rather than per organization, and delivers mail that was left stranded while that recovery was inert.
- Pressing resume-import while another agent is mid-turn no longer loses that agent's turn.
- Shows an automatic wake, such as an idle docket reminder, in the transcript of the turn it drove, instead of leaving that turn looking empty.
- Keeps the hire tokens on an agent card visible at maximum zoom-out, and stops a token from taking a click meant for the card next to it.
- Scales the notice that stands in for a popped-out desk like the desk it replaces, instead of drawing it about seven times too large with its buttons hanging outside the card.
- Keeps a history row's model chip on the same line as the agent's name.
- Shows the switchboard's agent-card shortcuts on hover and on keyboard focus.
