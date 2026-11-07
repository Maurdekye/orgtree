# Orgtree 4.5.6

Orgtree 4.5.6 adds a live feed of the engine's events for programs on your computer, lets a superior take unfinished jobs back from a project member, and makes Attract mode shorter on the docket and easier to take over. App panels now resize from every edge, and several freezes, wrong displays and animation bugs are fixed. It still bundles Mail hub 2.4.0.

## Live feed and projects

- **A live feed of what the engine is doing.** **Settings > Runtime > Live feed** publishes the engine's events on a local WebSocket (`ws://127.0.0.1:47830/v1/events` by default) for a stream overlay, a dashboard or your own program. It is on by default and listens on this computer only. Without an access token a program sees just two counts: agents in a turn and live agents. With an access token (made in Settings, copied once, revocable) it is bound to one agent and sees exactly what that agent could watch with an event watchdog. Change the port or switch the feed off in the same place. An agent's own WebSocket watchdog aimed at the feed is bound to its owner automatically.
- **Agents can take unfinished jobs back from a project member.** On a project that waits for acknowledgement, a superior agent can list the jobs members still hold (`held_jobs`) and take one, or all of one member's, back (`take_back`), the same as the desk's **take back** button. The job goes to the front of the queue for another listener, the attempt is counted, the holder gets one notice naming you and the reason, and its late acknowledgement is refused. The holder's process is not stopped.
- **Show more in the project desk's lists.** Recently Finished and Recently Delivered show the 10 newest rows. **Show N more** adds 25 at a time and **Show fewer** folds them back.

## Attract mode

- **The docket gets less screen time.** Attract mode spends at most about 15 percent of any five minutes on the docket and comes to it at most every fourth step. A visit is short: the ticket header, a two-second glide to the change and no more than 15 seconds. A ticket flagged for you gets one visit per five minutes.
- **Taking over stops it for good.** A real click, touch, wheel or typed key in a panel attract mode opened ends the run and leaves that panel yours. Alt+Tab, modifier keys, hovering and switching windows no longer count. After a takeover the next run waits at least 60 seconds with no input.
- **A run starts clean.** It closes every docket open in the window. A docket in its own popped-out window, or one floating beside the org docket, is treated as yours and left alone. An unowned docket left open is taken back after 60 seconds idle.
- **A trace to find problems.** While a run is active, attract mode writes its steps (kinds and timings only, never text) to `diagnostics/ui-attract.jsonl` in the data folder. It is separate from the freeze records and silent outside a run.

## Apps, canvas and desks

- **App panels resize from every edge and corner**, not only the south-east grip, like pinned desks and settings. The app inside never swallows the drag. Popped-out panels keep the system's resize.
- **Claude waves keep animating** while the window is visible but not focused, including a stream capture of it. A hidden or minimized window still stops drawing.
- **Epic mode no longer hums.** The continuous activity drone is gone. Event cues, tool sounds and the heat field are unchanged.
- **Event cards can lead with the message.** A WebSocket or MQTT event card can lead with the message's `text`, `message` or `body`, with the sender and kind above it and the rest under Details. It is a Display setting, **Show event message text as the card headline**, off by default.
- **A Hubchat reply's quote shows once.** The quoted line of the message a reply answers was repeated in the reply's text. Now it appears only in the reply block, and the desk and agents' mail carry just what the person typed.
- **Desk transcripts stay bounded.** A desk following the live end keeps its newest rows and drops the oldest, so a long-pinned desk no longer grows without limit. If you scroll up, you keep your rows and the newest are trimmed instead; the jump-to-bottom button brings you back.

## Agents

- **A Muse seat with shell and edit turned off keeps its Orgtree tools.** Its read-only posture used to deny every Orgtree tool call. It now asks like the other seats, lets Orgtree tools through and still refuses shell, writes and foreign servers.

## Fixes

- Right-clicking in a live desk no longer freezes it: an open transcript menu searched the whole transcript on every update.
- Older history pages on a desk always advance. A refresh that arrived with mail, and a live message older than the loaded rows, could leave the history cursor stuck so older pages showed "retrying" or never loaded.
- The mail-listeners table's fold controls are styled as links.

## Untested

- The live feed has been tested by automated tests with local test programs only, not with a real overlay or OBS.
- Attract mode's takeover and docket rules have been tested by automated tests and trace checks, not by a long unattended session.
- Muse's read-only Orgtree tools have been tested with simulated Muse models, not with a live Muse account.

## Notes

- There are no database changes and no installer changes in this release.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
