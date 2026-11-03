# Streamer mode (4.5.5)

User scope: on-screen only (2026-11-02 m2656d00014b4), all listed sensitive
categories and surfaces (mc8e118c58de9), implementation authorized m0103b81de013.
The App menu placement and visible indicator follow the coordinator's provisional
default and remain flagged for user confirmation. Native-picker exclusion is the
coordinator's explicit 2026-11-02 me7e21312f674 decision. Per-surface opaque-cover
dismissal is the user's m84e04d547421 ruling.

## Boundaries

- `packages/contracts/streamer.ts` owns detection, known structured values and
  the conservative native text policy. It never rewrites domain payloads.
  Over-masking guard (USER 2026-11-03 m73a2e0a527ec, alpha.2): ordinary text stays visible. Paths start at a
  boundary (never inside `orgtree/build-slot`, `integ/4.5.5`); IPv6 needs eight groups or `::` (a clock time is
  not one); phones need a `+`, grouped digits or a bare 7-15 digit run (dates and `GMT+2` are not); a 20+ character
  run is a secret only if `tokenLike` says so (not a git SHA, not a slug/branch of words and short numbers, not a
  plain camelCase name); known identities match whole words; `address`/`path`/bare `key` fields teach only values
  that look personal (agent names arrive under `*_address`). Pinned by `streamerovermask.test.tsx`.
- `streamer-boundary.ts` walks displayed DOM text and installs CSS Highlight
  ranges. The original text nodes stay intact, including native selection/copy.
  Blocks delimit labelled secrets; inline fragments are scanned together.
  DOM updates are processed by a MutationObserver before the next paint.
  Form-value paint is hidden without changing `.value`; tooltip/accessible labels
  are temporarily generic and restored on disable. Background images and generated
  content are hidden while enabled. Masking fails per value, never per window
  (USER 2026-11-03 m84db138f69e6): incomplete known identities keep pattern and
  known-value masks with a banner note; an unsupported Highlight API withholds text
  paint only (`streamer-textless`), leaving layout, controls and Turn off usable.
  Known values under three characters are ignored.
  Closed native selects show their value unless it matches a known identity or a
  sensitive pattern (hidden when unreadable or identities are unloaded). Media under
  48 px in both dimensions is hidden without a cover. Cost bound (USER 2026-11-03
  mb94508a32503 freeze): every pattern must be linear on long unspaced runs (the email
  pattern carries a lookbehind; a 40 KB token took 7 s), and mutation-driven rescans
  are paced after any scan of 16 ms or more (min(4T, 250) ms); update() scans at once. Only content surfaces
  (iframe, img, video, object, embed) get covers; canvas/svg are app chrome. A cover
  is its element's next sibling, absolutely placed in the same stacking context,
  never a fixed topmost layer (4.5.5-alpha.1 drew one over the whole canvas).
- `streamer.ts` owns synchronized native preference/browser-storage state and
  all registered documents, including portal popouts. It ignores superseded
  preference loads/saves. `api.ts` and `appfeed.ts` collect known structured
  identities before consumer rendering. Known values remain renderer-local,
  unpersisted, and are not collected from engine credential stores.
- HTML/media DOM covers retain the original element/runtime. Native artifact
  viewers (which do not load React) receive a separate opaque WebContentsView
  before their content loads. It is an inert page with only a cancelled-navigation
  dismiss action and no app bridge. Dismissal affects that surface only and is
  reset on reopen or mode cycle. Native holding/recovery pages use the same cover
  through `protectOpaqueDocument`, which ends when the window commits any non-data:
  document, however it was loaded.
- `streamer-native.ts` owns native title, menu, dialog and notice policy. Generic
  notification/title text never contains the original content; enabling closes
  retained notices. Native menus/dialogs keep callbacks and stable safe actions;
  uncertain labels are generic. Tray rows retain original navigation IDs while
  their names become generic; a mode change closes an already-open tray list.
  Conversion progress uses safe display text without changing conversion work.

## Explicit limits

Native OS file/open/save dialogs, including browser file inputs, are excluded and
are not blocked. Open select/date/color native popups are also excluded (coordinator
2026-11-02 md635a536434b); closed values stay masked and editors remain usable.
Input autocomplete attributes become off while active and are restored afterward.
Clipboard, links, submissions, stored data and agent context
retain originals. Opaque surfaces explicitly revealed by the user can show any
content. Recognition uses known structured identifiers plus conservative patterns;
an arbitrary unlabelled short string cannot be classified as a secret by syntax.
This is screen sharing assistance, not a data-access or credential security boundary.

## Evidence contract

The first test commit contains inert no-op feature interfaces, so the new tests
can execute against the pre-feature behavior rather than fail to import a missing
module. It does not activate a feature in the base application. `streamer.test.tsx`
checks each category across six DOM surface classes, split text/live changes,
original copy/editor/link data, fallback and cover lifetime. `streamernative.test.tsx`
checks native sinks/actions, picker exclusion, existing notices and native-view
covers. `streamerstate.test.tsx` covers preference races and popup synchronization.
`menumodes.test.tsx` is the shared menu contract from the attract-mode author.

These DOM tests prove ranges and state, not actual Chromium paint. Integration
must attempt one isolated, muted capture of real Highlight rendering, selected
text, editor masking, opaque/native covers and their dismiss/reset behavior. If
startup fails, record NOT_EXECUTED and seek coordinator disposition; do not claim
visual privacy was verified.

## Automatic on/off while a streaming app runs (USER 2026-11-03 m66c298e7345c; Discord model)

`apps/desktop/main/streamer-auto.ts`. Main process, one `tasklist` image listing every 5 s
(`ps -A -o comm=` off Windows); an unreadable listing is no verdict. Detected image names are
Discord's own Streamer Mode list (liaison m3669936358cc): obs, obs.exe, obs32.exe, obs64.exe,
XSplit.Gamecaster.exe, XSplit.Core.exe, Gamecaster.exe, bebo.exe, Streamlabs OBS.exe,
Streamlabs Desktop.exe, TwitchStudio.exe (case-insensitive, whole image name).
- Preferences: `streamerAuto` (Display switch; absent = ON) and `streamerAutoActive` (set only
  while the automation, not the user, turned the mode on). Any hand-made `streamerMode` write
  clears `streamerAutoActive` in `setPreferences`, so only the automation's own writes keep it.
- Start (or first sample at startup) with the mode off and the setting on turns it ON and flags it.
  The renderer banner then names the detected app from `STREAMING_APP_LABEL` ("turned on because
  XSplit is running": OBS, XSplit, Gamecaster, Bebo, Streamlabs, Twitch Studio), kept in the
  `streamerAutoApp` preference beside the flag.
- Exit needs two consecutive clear samples (no flapping on an OBS restart); it turns the mode OFF
  only when the flag is set. A mode the user had on, or turned on later, stays on.
- A manual off while a streaming app runs suppresses the automation until the app has exited and
  started again (in memory: an Orgtree restart during that run turns it on again).
- Startup: `app.whenReady` calls `settleStartupVerdict` before any window exists. Native masking
  (on by default) is released with `setNativeStreamer` only AFTER a definitive first verdict, a
  readable process list. Null, timed-out (4.5 s guard), thrown or slow listings are retried every
  0.5 s for at most 10 s (`STARTUP_CAP_MS`); at the cap the stored preference stands and
  `streamer auto: no readable process list ...` is logged. The automation's own write turns the
  mode on before native masking is evaluated. A persisted flag whose app is gone is released at
  the first verdict (coordinator maf0e03d7007b, from @build-sol's source read).
- Turning the setting OFF leaves the mode as it is (the user then owns it).
