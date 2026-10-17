# Response and task completion sounds

Successful responses and completed tasks have distinct sounds, independent
of mail notifications.

## Behavior

- `response`: one short sine tone after a successful normal agent turn has
  stored its turn ledger and agent state. Failures, cancellation, interruption,
  compaction and cache keepalive do not produce it.
- `task`: three ascending notes when an agent successfully calls
  `orgtree_status(status="done")`, or after a docket mutation commits a new
  `done` state. Accept uses the same update path. Creating an already-completed
  item also declares completion. Rewriting an item already in `done` does not.
- Both kinds cover all organizations, even when their windows are hidden.
  They do not need a user mail message, OS notifications, or an unfocused app.
- App settings > Runtime > Sounds contains **Response sound** and
  **Task completion sound**, each with its own **Preview** button. Both default
  on; older preferences acquire these defaults and saved choices persist.
- The OS app volume/output can still mute audio. Existing notification
  categories and their own sounds remain unchanged.

## Live transport and playback

The engine's app feed has a separate bounded cue channel (256). Cues contain
only kind, org ID and stable event ID, stamped with the app epoch and sequence.
Only `/api/app/ws?sounds=true` subscribers receive them. They are absent from
HTTP snapshots and state recovery; ordinary renderer sockets keep their existing
protocol. There is no offline/history replay.

Response IDs use the persisted turn ID; repeated agent done reports in the same
turn share an ID. Docket IDs use the item ID and revision. These are separate
completion declarations: a completed item and an agent's own done report are
distinct events. Post-commit docket effects prevent rolled-back changes from
playing a cue.

Electron main's single native app-feed connection consumes cues only after its
own initial snapshot and only for that epoch. A bounded identity history (1,024)
and monotonic sequence suppress duplicate frames/reports. A serial playback
queue (64) avoids overlapping tones and rechecks mute choices while draining.
Queue overload is diagnosed and skipped rather than blocking model turns or
building an unlimited backlog.

`SoundPlayer` lazily creates one hidden, unfocusable, sandboxed audio document
in its own memory session. It has no preload, desktop bridge, token or network
content. Only that document enables autoplay. Sine tones are synthesized locally
with Web Audio; the context suspends between cues. Navigation/popups and
permissions are denied. Playback has a three-second deadline; a failed audio
document is destroyed and the next cue may recreate it. Shutdown closes it.
See [Electron's BrowserWindow options](https://www.electronjs.org/docs/latest/api/structures/browser-window-options)
for the scoped autoplay and sandbox controls.

## Verification

- `cargo check --locked --manifest-path engine/rs/Cargo.toml -p orgtree-engine`
  checks the engine integration.
- `npm run typecheck` checks the desktop contracts and controls.
- `node tools/activity-sounds-smoke.mjs` checks 17 controls: distinct kinds,
  deduplication/order/org identities, independent mute/preview, preference
  persistence/old-file defaults, queue bounds, initial-copy/epoch gating and no
  snapshot replay. A real hidden Electron document plays both synthesized
  sequences, with AudioContext running then suspended. OS output is muted.
  The fixture uses a temporary profile and no provider calls or live data.

Physical speaker audibility depends on the operating system's selected audio
output and volume; the smoke does not change those settings.
