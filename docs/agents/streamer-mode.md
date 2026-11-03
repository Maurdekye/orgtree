# Streamer mode (4.5.5)

User scope: on-screen only (2026-11-02 m2656d00014b4). **What it hides is the user's DEFINITIVE LIST (2026-11-03
m63438d6bebc3), amended by maad1c88abeba, m4c7b46b6cffb and m10c6278e1744, which replaces every earlier category list.**
Native-picker exclusion is the coordinator's explicit 2026-11-02 me7e21312f674 decision. Per-surface opaque-cover dismissal is
the user's m84e04d547421 ruling. The toggles live only in App settings > Display (the App menu has no Modes section, USER
mb2d765cb0aa7); what is hidden is chosen in App settings > Streamer mode.

## What is hidden, and where

Eight types, one switch each in Settings > Streamer mode (persisted as `streamerPaths`, `streamerIps`, `streamerEmails`,
`streamerSecrets`, `streamerPhones`, `streamerTokenUrls`, `streamerExternals`, `streamerOrgs`; absent = default): local file
paths (default OFF), IP addresses, email addresses, secrets and keys, phone numbers, token URLs, external addresses
(`@net:`/`@org:`), other orgs' names (all ON), plus `streamerCover` (the cover over HTML apps, HTML presentations and video, ON).
Agent, project, account and model names, timestamps, SHAs, branch names, relative paths and plain URLs are NEVER hidden.
All types off is allowed; the indicator still shows. Changes apply live in every window through the preferences broadcast.

- **Free-form content** (transcripts, tool output, mail and message bodies, docket text, presentations, Hubchat, notes: the
  `STREAMER_ZONES.freeform` selector list in `streamer-boundary.ts`, centred on the `.md` markdown wrapper and `.msg`) is
  pattern-matched for the ENABLED types only; only the matching span blurs. `packages/contracts/streamer.ts` owns the
  patterns: absolute local paths only (drive-letter, UNC, `/c/`-style, unix roots); IPv4 (valid octets) and IPv6 (eight
  groups or `::`, never a clock time); emails; secrets (private keys, `password=`/`token=`/`api_key=` context taking ONE
  token, `Bearer`, known key prefixes, JWTs and random-looking long runs via `tokenLike`, never a SHA or other pure-hex digest,
  a slug/branch of words or a camelCase name); phones (`+` forms, grouped forms, `555-0123`; never dates, times, `GMT+2`, versions
  or plain digit runs); token URLs (credential parameters, `user:pass@`, invite/magic paths; plain URLs stay visible).
  Other orgs: exact, case-insensitive, word-bounded names/slugs from the live org list, 3-character minimum, the current org
  never (`setStreamerOrgs` in `streamer.ts`, fed from App's org list and refreshed while the switch is on).
- **Structured fields are never pattern-matched.** A field that is ALWAYS one type carries `data-streamer-field="<kind>"`
  (`email`, `path`, `ip`, `secret`, `external`, `org`; the table `STREAMER_ZONES.always` maps kind to type): it is wholly blurred
  while that type is on and wholly visible while it is off. Marked today: the usage panel's account emails, the provider
  account email, folder/path inputs and rows (org/agent folders, charter folders, profile folder), the language-server address
  and API key fields, the OpenRouter key field, hub address chips, other orgs in the org switcher. Every other field (names,
  chips, headers, timestamps, queue lines, selects, chart rows, settings labels) is never blurred. To protect a new field, mark it.
- **Blur, not boxes** (USER m4f8233662107): text spans and always-fields are transparent glyphs with two stacked
  `0 0 0.7em` shadows (`BLUR_EM`; `::highlight` accepts no `filter`); input-like always-fields get `data-streamer-blur`. Same
  box, no reflow. KaTeX formulas go through the same path: a sensitive TeX source blurs the whole rendered formula.
- **Opaque surfaces** (iframe, video, object, embed: sandboxed HTML apps, HTML presentations, video) keep the dismissable
  "Hidden in Streamer mode" cover (switchable); images are NOT hidden. A cover is its element's next sibling in the same
  stacking context, never a fixed topmost layer (4.5.5-alpha.1 drew one over the whole canvas); media under 48 px gets none.
- `streamer-boundary.ts` walks displayed DOM text and installs CSS Highlight ranges; original text nodes stay intact
  (selection/copy unchanged). Tooltip/accessible labels are generic only inside always-fields or when a free-form label
  matches. An unsupported Highlight API withholds text paint only (`streamer-textless`); layout, controls and Turn off stay
  usable (USER m84db138f69e6). Cost bound (USER mb94508a32503 freeze fix): every pattern is linear on long unspaced runs and
  mutation-driven rescans are paced after any scan of 16 ms or more (min(4T, 250) ms); update() scans at once.
- `streamer.ts` owns synchronized native preference/browser-storage state (on/off, the eight switches, the cover, the org
  list) for all registered documents, including portal popouts, and ignores superseded loads/saves. Nothing is learned from
  API payloads any more (the earlier known-identity learner was withdrawn with the account-name rulings).
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
content. Recognition uses patterns in free-form text plus explicitly marked fields;
an arbitrary unlabelled short string cannot be classified as a secret by syntax.
This is screen sharing assistance, not a data-access or credential security boundary.

## Evidence contract

The first test commit contains inert no-op feature interfaces, so the new tests
can execute against the pre-feature behavior rather than fail to import a missing
module. It does not activate a feature in the base application. `streamer.test.tsx`
checks each type across surface classes, split text/live changes,
original copy/editor/link data, fallback and cover lifetime; `streamerovermask.test.tsx`
keeps the user's alpha.2 screenshot surfaces visible; `streamertypes.test.tsx` covers the switches, structured fields,
other orgs and the settings category. `streamernative.test.tsx`
checks native sinks/actions, picker exclusion, existing notices and native-view
covers. `streamerstate.test.tsx` covers preference races and popup synchronization.
`menumodes.test.tsx` pins that the App menu has no Modes section; the Display toggles are in `streamerblank.test.tsx`.

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
