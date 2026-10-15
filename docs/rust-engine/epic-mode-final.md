# EPIC Mode — the final version (`epic/final`)

The user asked (2026-10-14 23:38Z, docket `add-the-secret-epic-mode`) for four
independent EPIC Mode takes — Wonder Full, Astra, Opus and Argon, each built on
its own from `rust-engine` `b77512f` — and then for one Opus reviewer to
combine them into a final version that picks out the best pieces of each, "to
make the final mode as EPIC as possible". This is that final version
(`epic-mode-final-combined-version-opus-review-mer`). Normal Orgtree keeps its
feedback restrained; EPIC Mode is the secret opposite. Every user action and
every system event gets a conspicuous animation and its own synthesized sound,
so a busy organization becomes a near-cacophony.

Branch `epic/final` holds the Opus take's five product and test commits
(cherry-picked with `-x`, unchanged) and the final version's commits on top of
them, so its diff against the approved Opus take (`fdd645f`) is exactly what
the merge added.

## The secret switch (shared by all four takes, as ruled)

User rulings 2026-10-14 23:42:07Z and 23:43:17Z, unchanged here:

- **Where:** Settings › Developer, the last row, below every other Developer
  option, always rendered.
- **Off, not hovered:** drawn in nothing but the background. The checkbox has
  no box, fill or ring, and the label's ink is transparent, so the row cannot
  be told apart from the empty panel in any theme. Select-all paints nothing
  around it, and the row stays outside the Debug group so no hairline marks it.
- **Hover:** one subtle highlight (the panel's own `--panel-2` hover surface);
  nothing else is revealed. Keyboard focus shows the same highlight instead of
  a focus ring (a choice the Opus take made; not ruled).
- **Click:** the box becomes the settings sheet's ordinary checked checkbox,
  and the name **EPIC Mode** appears in the theme accent.
- **Untick:** invisible again.
- **No** hint, on/off word, volume or mute control (Windows mutes per
  application), first-enable warning or reduce-motion handling.
- **Stored** as the optional native preference `DesktopPreferences.epicMode`
  (boolean only, absent = off, nothing written until first used). The main
  process broadcasts every preference write to every window, so it switches
  all windows at once and survives a relaunch. A plain browser keeps it in
  localStorage (`orgtree-epic-mode`).

The final version uses the Opus take's switch, the only one measured pixel by
pixel in all four contrast themes (round 451 and again here).

## How the four takes compare

Each take was read in full (source, tests, docs and rig receipts: rounds 448
Wonder Full, 449 Astra and 451 Opus; Argon's own logs, its round was still
pending), and every screenshot was inspected. Argon is compared as reviewed,
at `5650ef0`; round 452 later approved it at `6a078fc`, which is covered
after the credits.

| | Wonder Full `3f1efb4` | Astra `b04ed19` | Opus `fdd645f` | Argon `5650ef0` |
| --- | --- | --- | --- | --- |
| How events are seen | Clicks and keys classified by the control's label; a MutationObserver classifying appearing UI (toasts, tool chips, transcript rows by their wording); app-feed notices; a generic "org pulse" on live-bus bumps | Every non-GET `req` outcome; org-socket frames, including record-feed changes and runtime; the app-feed socket (notices, runtime values); clicks, keys, wheel, drags | App.tsx taps on parsed socket frames and on every published tree, diffed with the tree-is-a-selection rules; the interrupt call; app-feed usage readings; pointer, keys, wheel, drags, focus, copy/paste, file drops, dialogs, menus and toasts | `req` successes by route; socket frames; a tree diff inside a React component; clicks, keys, wheel |
| Inventory | 46 kinds | 27 cues | 57 org events, 38 user actions | 38 kinds |
| Pictures | Canvas sparks, confetti, shards, flakes, stars, octagon, bolt; word banners; combo meter; shake; ambient dust | Neon geometric glyph per kind; OVERDRIVE/HYPERDRIVE/ABSOLUTE CHAOS titles; heat halo, speed lines, arena corners | Lightning that re-forks; ice spikes, ice slab and snow; stop-sign slam; beams, vortices, comets, meteors, fireworks, coins, paw prints, cracks; CRT power-off; big outlined words; window shake and element glow | SVG crystal ice spike, octagon, bolts; canvas particles; emoji pill banners; combo HUD with ranks |
| Sounds | One recipe per kind; compressor; 14 voices; pitch climbs with the combo | 27 short cues; compressor; 48 voices; root climbs with the combo | 52 recipes (FM bells, brass, drums, filtered noise) through generated reverb and a limiter; 40 voices, light sounds capped first; stereo pan | Arpeggio table per kind; 18 voices; pentatonic notes for streamed tokens; no shared limiter |
| Off | Renders nothing; one preference subscription | Null-checked transport taps; one reused preference listener | One preference subscription per window; the director is a lazily imported chunk that is never fetched; three null-checked taps | Stage unmounted, but `epicModeOn()` reads localStorage on every socket frame and every API response (cached in its approved `8be2ecc`) |
| On | 700 particles; the frame loop runs for as long as it is on (ambient dust) | 40 impacts, 800 particles; canvas at most DPR 1.5 and 2.5 MP; stops when idle | 2,600 particles, 160 actors; one frame loop that sleeps when idle; adaptive quality; hidden windows draw nothing | Frame loop always running while mounted; a React state update per effect |
| Popped-out windows | None (documented) | Each adopted window follows | Each gets its own stage and listeners (wired, not exercised before) | None |
| Faults found | A remote retirement only shows as a generic pulse | — | A 100% usage reading staged as "LIMIT!" with a brown-out, against the user's ruling that a 100% reading is not exhaustion (extra credits); the stop sign staged before the interrupt request is answered, even when nothing was running | Interrupt tap matches `/nodes/:id/stop`, but the real endpoint is `/interrupt`, so the stop sign never fires from the app; a node missing from a tree is read as DISSOLVED and any first-seen node as HIRED (a tree is a selection, `treepresence.ts`). All fixed in its approved `8be2ecc` |
| Tests | 13 | 22, plus a 27-cue OfflineAudioContext check | 26, plus pixel-measured switch captures | 4 |

The base is the Opus take: the strongest architecture (nothing loaded while
off, one sleeping frame loop, correct hire/retire detection), the widest
inventory, the richest sound and the most legible art, with the strongest
tests. Its two faults are fixed with Astra's rules, and the other takes' best
ideas are rebuilt on its stage and synthesizer as one system each, rather than
glued on beside it.

## What came from which take

| Piece | From | Where |
| --- | --- | --- |
| The switch, its storage and tests; the lazily loaded director; taps; tree diffing; the user's hands; popped-out windows' stages; the one sleeping frame loop; 52 sounds; nearly every picture | Opus | `epic/*`, `canvas/accounts.tsx`, `main/policy.ts` |
| **The combo**: every staged event feeds one combo (2.5 s decay); milestones at 10, 25, 50, 100, 200, 400 | Wonder Full | `director.ts` (`feedCombo`) |
| Combo ranks SPECTACLE ONLINE, HYPER-STREAK, …, CACOPHONY MAXIMA | Argon (ladder), Astra (OVERDRIVE, HYPERDRIVE, ABSOLUTE CHAOS) | `RANKS` |
| The meter in the corner, its count and decay bar | Wonder Full, Argon | `stage.ts` (`meter`) |
| Heat: glowing edges, speed lines, arena corners closing in; neon rank titles | Astra | `meter`, `title` |
| The pitch ladder: little sounds climb up to an octave at 36 | Wonder Full | `CLIMB`, `climbFor` |
| The crystal ice spike erupting from a frozen card, then shattering | Argon | `stage.crystal` |
| The agent's name under every impact word | Argon, Astra | `captionOf`, `word({ caption })` |
| Streamed text as each agent's own pentatonic run | Argon | `noteRatio`, the `note` sound |
| Summoning portal for hires | Astra, Argon | `stage.portal` |
| Watchdog radar sweep and sonar ping | Astra, Argon | `stage.radar`, the `ping` sound |
| REFUSED: a change the engine rejects gets its own alarm; the interrupt's stop sign only once the engine answered `interrupted` | Astra | `api.ts` taps, `refused`, `stage.warn` |
| A 100% usage reading is a reading, never a limit | Astra | `usageMax`, the `maxed` sound |
| The canvas pixel budget (DPR ≤ 1.5, ≤ 2.5 MP) | Astra | `MAX_DPR`, `MAX_PIXELS` |
| Other organizations' notices | Wonder Full, Astra | `onNotices` |
| The pressed button pops; confirming clicks get stars and a coin ding; Undo/Redo buttons get the undo vortex | Wonder Full | `stage.pop`, `confirm`, `undo` |
| Keyboard navigation outside text fields | Astra | `navigate` |
| Tests: native preferences on disk; strict test-configuration trap; failed requests never celebrate; a 100% reading is not a limit | Astra | `epicmode-final.test.tsx`, `tools/rig/epic-mode-check.mjs` |

**Left out on purpose:**
- **Ambient dust (Wonder Full).** It needs a frame loop for as long as the mode
  is on. The final keeps an idle organization at zero frames.
- **Transcript-wording classification and the generic org pulse (Wonder
  Full).** Trees and socket frames already carry those events precisely, and a
  pulse would double every one of them.
- **Astra's glyph-and-label style for every event.** It turns into label soup
  under load (round 449's OVERDRIVE capture). Astra's titles, heat and arena
  are kept.
- **Argon's DOM/SVG overlays with emoji banners and a React update per
  effect.** Everything here is drawn on one canvas by the stage itself, in
  system fonts. Argon's on-state accent pill and on/off word go beyond the
  ruling, which names the checkbox and the label only.

**Argon's approved tip.** Round 452 approved Argon at `6a078fc` (product
commit `8be2ecc`), after this comparison. It fixes the faults above inside
Argon's own event plumbing, which the final version does not use, and widens
the routes and socket events Argon recognises. Re-read before the hand-in, it
adds nothing the final version lacks:

- The routes it now matches are staged here from what they change in the
  tree: a process started or stopped (the CLI waking or going to sleep), a
  compaction, a reorder, each retirement of a dissolve-all, the kill switch
  released, and frozen agents resumed or unstuck (**THAWED!**).
- An org-inbox read or a settings save is the user's own click: a Save gets
  the stars and the confirm ding, and a change to the org's own settings
  also turns the gears.
- Its new socket events (`hired`, `retired`, `interrupted`, `halted` and the
  rest) are not ones this engine sends. The org socket's only node pulses
  are `turn_done`, `frozen` and `renamed` (`changes.rs`, `Change::Pulse`).
- Its frame loop still runs on every frame while it is on.

## Off means off

While EPIC Mode is off, a window holds:

- the switch row (the trigger: always rendered, invisible);
- one native preference subscription (`epic/sync.ts`), the same kind the
  theme, contrast and Rainbow syncs hold;
- three null checks: `epic?.frame` and `epic?.tree` in App.tsx, and
  `epic?.refused` in `req`'s failure path. `interruptNode` checks `epic`
  once and, while it is null, returns the request untouched.

Nothing else. The director chunk is never fetched, no element is added, no
listener is attached and no AudioContext exists. `epicmode-off.test.tsx` counts
exactly this. Turning EPIC Mode off plays a CRT power-down and then removes
every listener, element, AudioContext and tap.

## How the show is built

| File | Role |
| --- | --- |
| `epic/pref.ts`, `epic/EpicSwitch.tsx`, `epic/epic.css` | The stored bit and the switch row |
| `epic/sync.ts` | Started by `main.tsx`; `import()`s the director when the bit turns on, stops it when it turns off |
| `epic/tap.ts` | The null-checked taps App.tsx and api.ts call |
| `epic/director.ts` | The show: taps, hands, popped-out windows, other orgs' notices, usage readings, the combo, and THE PLAYBOOK (one picture and one sound per event) |
| `epic/diff.ts` | Pure detectors: tree snapshots and their differences; spark, pulse and stream frames |
| `epic/locate.ts` | Where an agent, the eye, the org inbox or a watchdog is drawn |
| `epic/stage.ts` | One canvas per window: particles (glow, streak, shard, confetti, snow, coin, paw, smoke, star) and actors (rings, lightning, comets, impact words with captions, neon titles, ice spikes, crystals, ice slabs, stop signs, warning signs, portals, radar, beams, vortices, fireworks, meteors, cracks, gears, frames, flashes, flicker, CRT), the combo meter, the window shake and element glow and pop. Impact words, names, titles and glyphs draw over every glow and particle |
| `epic/audio.ts` | The synthesizer: 58 sounds from oscillators, FM pairs and filtered noise through a generated reverb and a limiter |

**Where events come from.** The org socket (mail sparks; `turn_done`,
`frozen` and `renamed` pulses; watched agents' transcript streams). Every tree
App.tsx publishes, reduced to a snapshot and diffed. A tree is a selection,
not a census, so a hire is a first-seen live node created in the last 45 s,
and a retirement is live then archived. The interrupt call, once answered.
Every refused non-GET request. The app feed: usage readings and other
organizations' notices. And the user's own hands: capture-phase passive
listeners, plus one MutationObserver for dialogs, menus and toasts.

**Placement.** An effect lands on the agent's card, else its open desk (in
any window), else a pinned frame, else the relevant toolbar button, else
somewhere central. Hires, rehires and renames wait for React to draw the card.
A move plays in two phases: a vortex where the card stood, then a comet to
where it landed. A refused change plays where the user last pressed.

**The combo.** Every staged event except a drag's trail and the director's
own fanfares feeds one combo. An event within 2.5 s of the last continues it;
otherwise it starts again at 1. From the third event, the meter in the
bottom-right corner shows the count, the rank and a bar running down to the
moment the combo drops. As it grows, the window's edges glow in the rank's
colour, speed lines stream outward and the corners close in like an arena. At
10, 25, 50, 100, 200 and 400 the new rank is announced across the window in
neon, with a confetti fountain, stars, rings, a growing shake and a brass
fanfare pitched up rank by rank. A new title ends the one before it. The
frequent little sounds (clicks, typing, ticks, tool clacks …) climb up to an
octave as the combo grows, so a busy organization audibly heats up. When the
combo drops, the meter fades and the frame loop sleeps again.

**Budgets.** At most 2,600 particles and 160 actors per window. One frame loop
per window, running only while something is alive. A frame over 12 ms thins
the particles born, down to a quarter. A hidden window draws nothing. The
canvas renders at most 1.5 device pixels per CSS pixel and 2.5 million pixels
in all. At most 40 voices, with the light, frequent sounds capped at 22; the
limiter keeps a wall of sound from clipping. Per-kind gaps keep echoes and
floods readable: a turn's end arrives as a pulse and again in the tree, and
plays once. A tree burst stages its first 40 events, and other orgs' notices
their first four. Any effect that throws is dropped without touching the app.

## The inventory: every event, its picture and its sound

Sounds are generated (named after their recipe in `audio.ts`). **Name**
means the agent's name rides under the word.

### EPIC Mode itself and the combo

| Event | Picture | Sound |
| --- | --- | --- |
| Switched on (this window) | White flash, five lightning bolts, **EPIC MODE**, shockwave rings, seven fireworks, confetti storm, big shake | Rising whoosh into a nine-voice orchestral hit, timpani, crash, thunder (`epicOn`) |
| A window opens with it on, or follows another window | Flash, two bolts, **EPIC MODE**, two fireworks | Thunder and chime |
| Switched off | The window collapses like an old picture tube | Power-down whine (`epicOff`) |
| Combo of 3 or more | The meter: **COMBO**, the rank, **×N**, the decay bar; heat, speed lines and arena corners as it grows | The little sounds climb with it |
| Combo reaches 10/25/50/100/200/400 | **HYPER-STREAK! / OVERDRIVE! / HYPERDRIVE! / SUPERNOVA! / ABSOLUTE CHAOS! / CACOPHONY MAXIMA!** in neon with **COMBO ×N**, confetti fountain, stars, rings, flash, shake | Brass run into a held chord, timpani, crash, shimmer, pitched up per rank (`combo`) |

### Agents and the org chart

| Event (how detected) | Picture | Sound |
| --- | --- | --- |
| Hire (new live node, recent `created`) | Summoning portal, beam onto the card, **HIRED!** + name, gold shockwave, confetti and stars, card glow, shake | Brass fanfare, timpani, cymbal (`hire`) |
| Rehire (archived → live) | Portal, outward vortex, beam, **BACK FROM THE ARCHIVE!** + name | Fanfare a step up and shimmer |
| Retire (live → archived) | Rising smoke, inward vortex, slow ring, **RETIRED** + name, souls rising | Gong and a rising whoosh (`retire`) |
| Move (parent changed) | Vortex where it stood, comet, vortex and **TELEPORTED!** + name where it lands | Teleport bwoop and whoosh (`move`) |
| Reorder | Streaks | Two quick slides (`reorder`) |
| Rename (`renamed` pulse) | **RENAMED!** + new name, sparkle | Scribble and chime |
| **Freeze** (`frozen` pulse or `frozen` set) | **The ice spike**: a crown of crystals erupts from the card, spikes burst out of it and an ice slab frosts over it, snow falls, then the crystals shatter; **FROZEN!** + name, cold flash, shake | Ice crack, crystalline cluster, deep whump (`ice`) |
| Usage-limit freeze (`frozen.until`/`limit`, `limit_locked`) | The ice spike with a brown-out flicker and falling sparks, **LIMIT HIT!** + name | Ice and power failing (`powerFail`) |
| Thaw | Ice shards burst out, warm glow, **THAWED!** + name | Rising glassy arpeggio, melting sweep (`thaw`) |
| Halt | Three red flashes and rings, 0.36 s apart, **HALTED** + name, shake | Klaxon over a boom (`halt`) |
| Unhalt | Green flash, beam, **RESUMED!** + name | Power back up into a chord (`resume`) |
| **Interrupt** (the call, once the engine answered `interrupted`; a killed turn) | **A stop sign slammed down** on the card, its name under it, red shockwave, sparks, hard shake | Brake screech into a metallic impact (`stop`) |
| Killswitch on / off | Red screen, **ALL STOP**, meteors, cracked glass, biggest shake / green flash, **ALL GO!**, fireworks | Klaxon and explosion / power up and victory fanfare |

### Turns, tools and thought

| Event | Picture | Sound |
| --- | --- | --- |
| Turn starts / ends | Flames erupt from the card / golden burst, **DONE!** | Engine revving (`turnStart`) / two-bell chime (`turnEnd`) |
| Tool call / finished | Spinning gear, sparks, the tool's name (**BASH!**, **EDIT!** …) / small burst | Ka-chunk and laser pew (`tool`) / blip |
| Thinking | Purple motes rising | Shimmer |
| Writing (streamed text) | Small sparks | **The agent's own pentatonic run**: one plucked note per 240 ms, up and down the scale, each agent from its own degree so writers sound like a chord (`note`), over a pen scratch |
| Compaction | Grey vortex, then shards, **CRUNCH!** + name | Crusher grinding down (`compact`) |
| Error (`last_error`) | Cracks, red shards, **ERROR!** + name | Buzzer and breaking glass (`error`) |
| Status report: working / blocked / idle | **ON IT!** / **BLOCKED!** with red shards / **REPORTED IN**, + name | Wake / deflate / chime |
| Waiting | A big pulsing **…** | Tick |
| Model or tier / account / effort | Rainbow rings and the tier's name / **NEW ACCOUNT!** and vortex / gear and **EFFORT: HIGH**, + name | Slot reels and a ding / slot reels / clack |
| Credits granted or moved | Gold coin fountain, **+4 CREDITS** + name | Cash drawer and coins (`coins`) |
| CLI started / warm / closed | Ring / spark / grey puff and **z z z** | Wake / blip / sleep |
| Mail queued / waiting mail grew | Gold ring / sparks | Blip / notice |

### Mail, questions, documents, the docket, watchdogs and the rest

| Event | Picture | Sound |
| --- | --- | --- |
| **Message spark** (agent → agent) | **Lightning** from sender to recipient, sparks at both ends, **ZAP!** | Electric arc with crackle (`zap`) |
| The user sends / mail to the user | Gold comet from the eye, **INCOMING!** / gold lightning to the eye, **FOR YOU!** | Rocket launch / high zap and notice |
| Org inbox (outside mail) | A meteor strikes the org-inbox tile, **OUTSIDE MAIL!** | Explosion |
| User inbox grew / urgent mail | **MAIL!** at the ask bell / **the alarm**: every window showing the org tinted red, deepest at the edges, in smooth pulses 0.8 s apart under **URGENT MAIL!** + sender, until the mail is read or for 8 s; a giant **!**, shake | Chime / a klaxon and a red ping from the ask bell every pulse (`klaxon`) |
| Question opened / answered | Giant **?**, lightning from the sky, flash, ring, name / **ANSWERED!** + name, rising sparks | Three brass hits over a timpani roll (`question`) / harp glissando |
| Document presented | Beam, **TA-DA!** + name, confetti | Two-note brass ta-da |
| Ticket opened / closed / flagged | **NEW TICKET!** at the docket bell / fireworks, confetti rain, **TICKET CLOSED!** / red and blue flashes 0.36 s apart, **!**, **ATTENTION!** | Rubber stamp / victory fanfare / siren |
| **Watchdog fires** | A radar sweep at the watchdog, a comet from it, paw prints, **WOOF!** + name | Two synthesized barks over a sonar ping (`bark`, `ping`) |
| Watchdog created / removed | Paw prints, **GOOD DOG!** / grey puff | Small bark / sleep |
| Audience granted / revoked | Triple rainbow lightning between the pair, **AUDIENCE!** / grey puff | Chime / deflate |
| Credit request / org cost jumped | A giant **$?** / coin rain | Coins |
| Org settings changed | Two gears spinning in the corner | Clack |
| **Another org's notice** (question, urgent mail, failure, frozen agent, ticket attention, document, report), in the window the user is looking at | That event's own picture at its toolbar bell or centre, with **agent · org** under it; a report is **REPORT!** | That event's own sound |
| Usage reading crosses 90% / reaches 100% / drops back | **CLAUDE 92%!** / **CLAUDE 100%!** with streaks and a ring, a reading, never a limit / **REFILLED!** with coin rain | Siren / a meter maxing out: rising sweep, three beeps, a bell (`maxed`) / power up and coins |
| **A change the engine refused** | A warning sign where the user pressed, cracked glass, **REFUSED!** with the HTTP status, red flash, shake | A denied double buzz over a thud (`refused`); an error toast right after it adds no second alarm |
| Org socket dropped / back | Brown-out, **SIGNAL LOST** / green flash, **BACK ONLINE!** | Power failing / power up |

### The user's own hands

Every pressed button, tab, menu item, option or switch pops (scale, reverting
by itself).

| Action | Picture | Sound |
| --- | --- | --- |
| Click a control | Sparks and a ring | Thock and tiny pew (`click`) |
| Click a confirming control (save, apply, create, add, OK, done, accept, approve, submit, grant) | A burst of stars and a ring | Two-coin ding (`confirm`) |
| Send / reply | Sparks and a comet launched upward | Rocket |
| Delete / remove / retire / dismiss | Smoke puff | Thud |
| Tab, checkbox, select | Streaks / gear and sparks / ring | Blip / clack / slot reels |
| Double-click | Two rings | Double click |
| Type / Enter / Backspace | Sparks at the caret / sparks and ring / grey puff | Typewriter / carriage-return bell / low strike |
| Zoom (the camera zoomed) / scroll (something scrolled) / pan / drag a card | Warp streaks / streaks / trail / ring, dust cloud and small shake | Warp / tick / — / grab, thud |
| Menus, popups, dialogs, toasts | Rings and frames; dialogs flash and frame | Whooshes; notice |
| Error toast | Cracked glass, red frame, shake | Breaking glass and buzzer |
| Copy / paste / undo / redo (the chord, or an Undo/Redo button) / other shortcuts | **COPIED! / PASTED! / UNDO! / REDO! / CTRL+K** | Blip / stamp / warp / clack |
| Arrow, page, home and end keys outside text fields | Chevron streaks the way it moved | Warp, up or down |
| Keyboard focus moves | A frame around the focused control | Blip |
| Drop files | Gold vortex, **INCOMING FILES!** | Conveyor whirr |

Hovering is deliberately silent: it would never stop. A wheel plays what it
moved: a zoom only when the canvas camera zoomed, a scroll whenever anything
scrolled (a pinned window, the agents list, a desk, a panel), and nothing when
it moved nothing, such as a list at its end or the camera at its zoom limit
(see [the wheel fix](#a-wheel-plays-what-it-did-fix-2026-10-15)).

## Engine changes

None. The desktop main process accepts `epicMode` only as a boolean, and the
contract gains one optional field. Both come from the Opus take.

## Verification

`tools/rig/epic-mode-check.mjs` runs as one heavy phase under the machine
build lock and a kernel memory cap. Dependencies are read in place from an
existing checkout; nothing is copied or linked, and output goes under
`C:\orgtree-build\<agent>`.

```text
powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/renderer/tests/joblimit.ps1 `
  -LimitMB 4096 -TimeoutSec 1500 -WorkDir <repo> -Exe <node.exe> -ArgFile <args.txt>
args.txt: tools/rig/epic-mode-check.mjs, <dependency root>, <empty C:\orgtree-build\<agent>\... dir>,
          --base-tree, <clean checkout of b77512f>   (add --inside when the caller holds the lock;
          --neighbors, <suite,suite,...> also runs those existing suites green on the tip;
          --before, <sha> also runs the suites with the sources changed since <sha> loaded as there)
```

It runs the root typecheck. It runs the strict renderer and test
configurations at the tip and at the base, comparing diagnostics by file and
code. The test overlay clears the inherited `exclude: ["tests"]`, which
otherwise silently skips every suite. It then runs the EPIC suites (four at
the hand-in, five since the caret fix below) three ways:

- **green:** tip tests on tip source;
- **red:** tip tests on the exact base `b77512f`, with the absent
  `src/epic` modules stubbed;
- **Opus control:** tip tests on the approved Opus take `fdd645f`, with
  every file the final version changed loaded as it was there.

The tests that fail in the control are exactly the merge's additions. With
`--neighbors` it also runs existing renderer suites green on the tip, for the
behaviour the final version's edits sit next to: `api.ts`'s request and
interrupt paths, the app feed and the settings panel. `summary.json` lists
every test's outcome per mode.
`tools/rig/epic-mode-visual.mjs` photographs the real settings panel and a
synthetic org chart in an offscreen Electron window. It measures the switch
pixel by pixel in all four contrast themes and records every word each effect
painted. Since the caret fix it also types into desks on the canvas and a
pinned one and measures where each typing effect lands; `--before <sha>`
bundles the fixture with the sources changed since `<sha>` as they were there.

- `epicmode-switch` (9), `epicmode-off` (3) and `epicmode-engine` (14) are the
  Opus take's suites. The engine suite now also requires the new kinds and
  sounds, and that every new effect draws its words.
- `epicmode-final` (16) covers the merge. Each test runs through the module
  the piece lives in, and through the real `api.ts` and app feed where the
  piece taps them:
  - the combo: ladder, milestones and meter, the loop sleeping once it
    drops, and one title at a time;
  - words drawing over every glow and particle, so names stay readable;
  - the pitch ladder and the pentatonic runs;
  - the hands: a confirming click, an Undo button and keyboard navigation,
    while typing stays typing;
  - names that never show the user or a watchdog's id;
  - the crystal ice spike shattering;
  - a refused change (GETs and expected answers stay quiet);
  - an interrupt staged only once accepted;
  - other orgs' notices, and a 100% reading that never says LIMIT;
  - the canvas pixel budget;
  - a popped-out window's own stage, exercised for the first time;
  - the native preferences file surviving a restart.
- `epicmode-caret` (4) is the caret fix's: typing, Enter and Backspace cued
  at the caret in a field scaled 0.5 and 1.5, in a pinned one, and in
  scrolled ones (below).

### Measured

At the hand-in code, `72e6c44`, with a clean tree. The commits after it
change only the check runner (`06a0c92` adds `--neighbors`), this document
and AGENTS.md. Measured under the machine build lock and a 4,096 MB kernel job
(C:\orgtree-build\epic-final\check-4, visual-3 and, at `06a0c92`, check-5):

| Check | Result |
| --- | --- |
| Root typecheck | Exit 0 |
| Strict renderer configuration | 29 diagnostics at the tip and 29 at `b77512f` (clean checkout): none added, none removed, none in EPIC files |
| Strict test configuration | 830 at the tip and 830 at `b77512f`: none added, none removed; all four EPIC suites are in the file list |
| Green (tip) | 42 of 42 pass, none skipped: switch 9, off 3, engine 14, final 16 |
| Red (`b77512f`) | 0 of 42 pass: all 42 executed and failed |
| Opus control (`fdd645f`) | 25 of 42 pass. The 17 that fail are the final version's additions: the engine suite's three coverage checks (new kinds, new sounds, new words), and 14 of the 16 final-suite tests. The two that pass, a popped-out window's own stage and the native preferences file, are the Opus take's own behaviour, exercised by the final suite for the first time |
| Neighbor suites (`06a0c92`) | 67 of 67 pass, none skipped, in ten existing suites: haltcontrol, stopnonjson, crossprovider, appnotices, appvalues, apporgs, appsettings, appsettingsclose, rainbowsetting and enginedebug. The same run repeated green: 42 of 42 |
| Screenshots | Passed; 34 PNGs, every one inspected. In Charcoal, Light, Solarized Light and Obsidian Black, the switch row is exactly the panel background when off, one subtle colour when hovered (rgb 45,45,48 / 232,235,239 / 233,226,203 / 25,25,25), checked with its label equal to the theme accent when on (the fixture's Orgtree slate accent, rgb(182,189,200)), and the background again when unticked. Each effect's painted words are recorded and match its picture |

Earlier runs found two real bugs in the merge's screenshots, both now fixed
and tested:

- At `711431c`, two ranks reached in one burst printed their titles over
  each other ("HOVERDRIVE!K!"). A new title now ends the one before it.
- At `961f0ac` (41 tests, the same zero-diff strict results), the agents'
  names were washed out under glows: DAVE under the hire portal's light,
  BOSS under paw prints, EDIT! under a rank title. Impact words, names,
  titles and glyphs now draw after every glow and particle.

### Typing at the caret in a canvas desk (fix, 2026-10-15)

On the installed 4.3.0-alpha.5.epic-final build the user found the typing
effects out of sync in a desk on the canvas, and in sync in a pinned one
(docket `epic-mode-typing-effects-desync-in-canvas-desks`).

**Cause.** `caretSpot` (`epic/director.ts`) places the effects of typing,
Enter, Backspace and paste. It took the field's box from
`getBoundingClientRect()`, in screen px, and added the text before the caret,
the padding and the scroll offsets, all in the field's own px. A desk on the
canvas sits inside the camera's `scale(view.z)` on `.space` and
`.desk-inner`'s `scale(0.13333 × --desk-dpi)`. Its scale on screen is
therefore `view.z × 0.13333 × dpi`: about 0.28 at the desk threshold (zoom
2.1), 1.6 at the zoom limit (12), and close to 1 only near the usual focus
zoom. Each effect landed (1 − scale) × the text width away from the caret:
to the right zoomed out, to the left zoomed in or at a larger desk text size,
and further with every character. A pinned desk renders outside both
transforms, and a popped-out desk is its own window, so their scale is 1. The
stage was never involved: it covers the window, so window coordinates map
one to one.

**Fix.** The field's screen scale, `box.width / offsetWidth` (and the same
for heights), carries those offsets onto the screen. The field's border
(`clientLeft`/`clientTop`) is counted too; the desk composer has none.
Pinned and popped-out desks keep scale 1 and behave as before. While EPIC
Mode is off nothing changes: the code is in `director.ts`.

**Tests.** `epicmode-caret` gives jsdom fields the geometry a transform
gives them: the screen box scaled, `offsetWidth/offsetHeight` not. The visual
capture's typing scene has two composers on the canvas, nested as the app
nests them (one at `--desk-dpi` 1.5), and a pinned one. It types real
keystrokes into each at zoom 3.75 in Charcoal and at 11.25 in Light, and pans
the camera between keystrokes. Every caret effect is compared with the true
caret, computed from the fixture's own scale and a browser-laid-out text
probe rather than from the director's estimate (tolerance 1.5 px), and with
where its sparks were drawn. `--before 296deb0` runs both against the
integrated final version, without the fix.

Measured at `6ed3c77` with a clean tree, under the machine build lock and a
4,096 MB kernel job (C:\orgtree-build\epic-final\canvas-typing: check-2,
visual-2, visual-before):

| Check | Result |
| --- | --- |
| Root typecheck | Exit 0 |
| Strict renderer configuration | 29 diagnostics at the tip and 29 at `296deb0` (clean checkout): none added, none removed, none in EPIC files |
| Strict test configuration | 830 and 830: none added, none removed; all five EPIC suites are in the file list |
| Green (tip) | 46 of 46 pass, none skipped: switch 9, off 3, engine 14, final 16, caret 4 |
| Before (`296deb0`) | 43 of 46 pass. The three that fail are the caret suite's canvas and scroll tests: at scale 0.5 the effect was cued at x 177 for a caret at 138.5, at 1.5 at 177 for 215.5, and in a scrolled one-line field at 140 for 160. The pinned control passes |
| Red (`b77512f`) | 0 of 46 pass: all 46 executed and failed |
| Opus control (`fdd645f`) | 26 of 46 pass. The 20 that fail are the 17 additions listed above and the same three caret tests: the Opus take has the same caret maths, and its pinned control passes |
| Typing capture (tip) | Passed, with native keystrokes. Every caret effect lands within 0.02 px across and 0.21 px down of the true caret, at scale 0.5, 0.75 (`--desk-dpi` 1.5), 1.5 and 1 (pinned), before and after a pan. Every spark is drawn exactly at its effect's spot, and the stage is the window. 41 PNGs: the 34 above and 7 of typing |
| Typing capture (`296deb0`) | Failed as expected. Zoomed out, the effects landed 35.7 to 92.4 px right of the caret (scale 0.5) and 17.8 to 46.2 px right (0.75); zoomed in, 35.7 to 92.4 px left (1.5); up to 14.7 px off vertically. The pinned desk was within 0.01 px both times |

The first tip capture (before the capture's pacing fix, folded into the test
commit) put every effect at the caret, but one keystroke in the pinned desk
drew nothing. Two key events reached the page within the director's 22 ms
gap between typing effects, so the second rightly played nothing. The capture
now waits for each key to land, plus 60 ms, and records the gap between
effects.

### A wheel plays what it did (fix, 2026-10-15)

With EPIC Mode on, the user found that scrolling a pinned window on the canvas
played the canvas's zoom effects instead of the scroll effects, and then the
same for the agents list (docket
`epic-mode-scrolling-a-pinned-window-on-the-canva`).

**Cause.** The hands' wheel listener (`epic/director.ts`) decided by where the
wheel landed: inside `.viewport` it cued zoom in or out by the wheel's sign,
and anywhere else scroll. The canvas's own wheel listener (`OrgCanvas.tsx`)
never zooms over a pinned window (`.pinwin`), the agents list (`.tray`), a
focused desk (`.desk-over`) or a modal (`.overlay`): it leaves those wheels to
the browser, which scrolls them. Every other wheel over the canvas is
`preventDefault()`ed and zooms the camera, clamped between the minimum zoom
and `Z_MAX` (12). Pinned windows, the agents list and focused desks are drawn
inside `.viewport`, so scrolling them played the zoom effect, and so did a
wheel that moved nothing: a list at its end, or the camera at its limit.
Canvas modals are portaled out of `.viewport` (`ModalOverPins`), so they
played scroll, but also at their ends.

**Fix.** A wheel now plays what it moved. At the wheel the hands note the
camera's zoom (the `scale()` OrgCanvas writes on the `.space` of the wheel's
canvas) and the scroll offsets of the target and every element above it, then
look again on each of the next six frames:

- **zoom in or out** when the canvas took the wheel (`defaultPrevented`) and
  the camera's scale changed, larger meaning in. A camera gliding on its own
  (a focus) while the wheel scrolls a window is not the wheel's zoom;
- **scroll** when one of those offsets moved, pointing the way it moved (the
  wheel's sign for a sideways-only scroll, as before);
- **nothing** when the wheel moved nothing.

One wheel plays at most one effect. Looks still pending when the hands detach
are cancelled. Popped-out windows have no camera, so only their scrolling
plays. All the code is in `director.ts`, which loads only while EPIC Mode is
on.

**Tests.** The new suite `epicmode-wheel` mounts the REAL `OrgCanvas` with the
real director on top. jsdom does no layout, so each scroller is given the
geometry a browser would give it, with its offset clamped to its range. After
each wheel the test does what the browser does: a wheel nobody prevented
scrolls that element by its delta, as far as its range allows, and fires
`scroll` if it moved. The cases:

- a pinned window: scrolling up and down, its newest line, and a wheel landing
  while the camera glides to another agent;
- the agents list: down, up and its top;
- a focused desk on the canvas;
- an agent's docket, opened from the agents list, as an ordinary panel: down,
  up and its top;
- a real canvas zoom in and out (the control), and the zoom limit;
- a panel outside the canvas.

The visual capture's wheel scene runs the real canvas in Electron with cto's
desk pinned, the agents list open and then cto's docket. It sends native wheel
input over each, over a free point of the canvas, and out to the zoom limit.
The page records every wheel apart from the director: whether the canvas took
it, the camera's zoom and every scroll offset that moved. Each effect played
must match what moved. A filler after the pinned chat and the modal panel
stands in for a long conversation and a long docket, and the fixture answers
a desk's chat route with an empty conversation.

Measured at `c02181c` with a clean tree, under the machine build lock and a
4,096 MB kernel job (C:\orgtree-build\epic-final\wheel: check, visual,
visual-before):

| Check | Result |
| --- | --- |
| Root typecheck | Exit 0 |
| Strict renderer configuration | 29 diagnostics at the tip and 29 at `7f5f27f` (clean checkout): none added, none removed, none in EPIC files |
| Strict test configuration | 836 and 836: none added, none removed; all six EPIC suites are in the file list |
| Green (tip) | 55 of 55 pass, none skipped: switch 9, off 3, engine 14, final 16, caret 4, wheel 9 |
| Before (`7f5f27f`) | 47 of 55 pass. The eight that fail are the wheel suite's: scrolling the pinned window, the agents list and the desk played zoom (zoomIn or zoomOut by the wheel's sign), so did the pinned window at its newest line and a wheel during the camera's glide, the zoom limit played zoomIn, and the docket and the outside panel at their ends played scroll. The canvas zoom control passes |
| Red (`b77512f`) | 0 of 55 pass: all 55 executed and failed |
| Opus control (`fdd645f`) | 27 of 55 pass. The 28 that fail are the 17 additions listed above, the three caret tests and the eight wheel tests; the zoom control passes |
| Wheel capture (tip) | Passed, with native wheel input: every one of 11 wheels played what it moved. The canvas zoomed in and out (0.24 ↔ 0.277): one zoom effect each. The pinned chat scrolled up and back (1256 ↔ 1136 px), the agents list and the docket down (0 → 120 px): one scroll effect each, pointing the way it went. The pinned chat at its newest line, the agents list and the docket at their tops, and the camera at its limit (12): nothing. Zooming back out from the limit played zoomOut. Each effect started 37 to 68 ms after its wheel (the capture draws at 30 frames a second). No console errors. 47 PNGs: 41 as before and 6 of the wheel |
| Wheel capture (`7f5f27f`) | Failed as expected, 7 of 11: the pinned chat scrolling up and down played zoomIn and zoomOut, and at its newest line zoomOut; the agents list scrolling down played zoomOut, and at its top zoomIn; the docket at its top played scroll; the camera at its limit played zoomIn. The canvas zooms and the docket's scroll were already right |

### Urgent mail sounds the alarm (2026-10-15)

The user tested urgent mail on the 4.3.0 candidate: "yep, it has an effect,
but it's not significantly more impressive or eye catching than anything else",
and asked for "a massive blaring alarm that tints and fades the entire screen",
"not excessively loud but very attention demanding and obnoxious" (docket
`epic-mode-make-urgent-mail-s-effect-much-more-ey`, merged into
`epic-mode-next-round-more-shake-and-blur-a-small` as its part 5). The old
effect was a siren whoop, four red and blue full-window flashes 210 ms apart and
a giant **!**: short, and at 4.8 flashes a second above the three-a-second
limit.

**The alarm.** Urgent mail is now the loudest moment in the show:

- every window the show draws in (the main window and any popped-out one) is
  tinted red, deepest at its edges (the middle at about a third of the edge's
  strength, so the content stays readable), at most 0.34 opaque, under a big
  **URGENT MAIL!** banner naming the sender (`Stage.alarm`);
- the tint and the banner rise and fall in smooth pulses, one every 0.8 s
  (1.25 a second), never a hard flash;
- once a pulse, a klaxon cycle (`klaxon`: two notes a minor third apart, each a
  buzzing square ground against a sawtooth a semitone below it, under an 11 Hz
  warble) and a red ping ring from the ask bell. The klaxon peaks at the
  siren's level and plays at EPIC's normal gain: it is obnoxious by its
  character, not by its volume;
- a short shake and a giant **!** at the ask bell mark the start.

It ends when the urgent mail is read (the org's `urgent_unread` falls), when
another urgent mail starts its own alarm, when EPIC Mode stops, or by itself
after 8 s (ten pulses), fading out over 0.8 s. It plays once per urgent
message: it fires when `urgent_unread` rises, so the same tree delivered again
plays nothing, and urgent mail already waiting when EPIC Mode turns on is part
of the first tree, the baseline. Another organization's urgent mail comes as a
notice in the app feed and, in the window the user is looking at, sounds the
same alarm. That alarm ends when its own notice leaves the feed, because its
mail was read; another notice leaving does not end it (coordinator ruling
after review, 2026-10-15). EPIC Mode has no mute or volume setting of its
own, so the alarm plays at the normal level. All of it is in `src/epic`
(director, stage and audio), loaded only while EPIC Mode is on.

**Tests.** `epicmode-urgent` gives each window's stage a recording context that
remembers its `globalAlpha` and notes, frame by frame (a frame starts at the
stage's `clearRect`), the strongest fill covering the whole window: the tint's
level over time. Urgent mail must tint the whole window strongly, still be
tinting almost three seconds on, pulse with each rise at least 0.4 s after the
last and never more than three in a second, and tint a popped-out window
showing the org too. One sound must repeat as the alarm, at no gain above 1.
Reading the mail must end it within a second, and unread it must end within ten
seconds. Ordinary mail must not tint the window or repeat a sound, and the same
urgent mail delivered again must stage nothing. Two urgent notices from another
organization come through a stubbed app feed: once the newer one's alarm has
taken over, the older one leaving must leave it sounding, and the newer one
leaving must end it within a second, klaxon and all. The visual capture's urgent
section photographs the alarm in the stage scene (now with an ask bell) in
Charcoal and in Light: before it, at a pulse's peak (0.4 s) and trough (0.8 s),
at a peak 3.6 s on and after it ended (9 s). It measures the redness (red minus
the mean of green and blue) of a corner and of the middle against the picture
before it.

### Flashes at most three a second (2026-10-15)

The user found the "ticket flagged" (attention) effect flashing red and blue
four times about 210 ms apart, roughly 4.8 flashes a second, above the
three-a-second photosensitivity guideline, and asked to "slow it to at most 3
per second, keeping the same look" (docket
`epic-mode-next-round-more-shake-and-blur-a-small`, part 6). A halt flashed red
three times 240 ms apart, about 4.2 a second, and the coordinator ruled that it
is slowed the same way. Both now space their flashes `FLASH_EVERY_MS` = 360 ms
apart (2.8 a second), with the same count, colours, strength and length, and
the halt's three red rings still go out with its flashes. 360 ms also lands the
halt's first and last flash on the first and last beat of its alarm, whose
sound is unchanged. Every other flash is a single one per event.

**Tests.** `epicmode-comfort` notes every `Stage.flash` and `Stage.ring` call
while one attention and one halt play. Each must keep its look (the same count,
colours, strength and length, and the halt's rings starting with its flashes)
and flash at most three times a second: each flash at least a third of a second
after the one before, and never more than three starting in any one second.

Measured with a clean tree, under the machine build lock and a 4,096 MB kernel
job: the checks at `3083e37` (C:\orgtree-build\epic-final\next1\check-2), the
captures at `93f201d` (next1\visual, next1\visual-before). Between those two
commits only how an alarm started by another organization's notice ends
changed, which the captures do not exercise.

| Check | Result |
| --- | --- |
| Root typecheck | Exit 0 |
| Strict renderer configuration | 29 diagnostics at the tip and 29 at `f1eed04` (clean checkout): none added, none removed, none in EPIC files |
| Strict test configuration | 830 and 830: none added, none removed; all eight EPIC suites are in the file list |
| Green (tip) | 64 of 64 pass, none skipped: switch 9, off 3, engine 14, final 16, caret 4, wheel 9, urgent 7, comfort 2 |
| Before (`f1eed04`) | 57 of 64 pass. The seven that fail are the five alarm tests and the two flash-rate tests |
| Red (`b77512f`) and Opus (`fdd645f`) controls | Not executed: their bundles no longer build, because the tip's `canvas/modals.tsx` imports `refreshSkills` and `refreshGlobalInstructions`, which their `api.ts` lacks |
| Urgent capture (`93f201d`) | Passed in Charcoal and Light: the corner's redness 70 and 72 at a pulse's peak, 21 and 22 at a trough, 70 and 72 at a peak 3.6 s on, 0 after the 8 s end; the middle's 26 and 25. 57 PNGs, no console errors |
| Urgent capture (`f1eed04`) | Failed as expected: no redness at any moment, in either theme |

## Limits

- Synthetic state and transports only: no live organization, provider
  traffic, credentials or application data. Physical audio and subjective
  sound quality are not measured; the tests check that every recipe builds
  its nodes. The visual fixture uses offscreen Electron with software
  compositing in Session 0, at DPI scale 1.
- Interrupts are seen when the engine accepts one through the API, and when
  a turn ends killed. An engine-side interrupt with neither leaves no mark.
- Tool calls of unwatched agents come from the runtime overlay, coalesced
  every 40 ms, so a very short call can be missed.
- Docket events are the org's counts (opened, closed, flagged), not every
  per-ticket transition.
- Other organizations' notices play only in a window the user is looking at.
  With every Orgtree window in the background they stay silent, while the
  native notification still appears. The baseline is the first complete copy
  of the feed: notices waiting before EPIC Mode turned on are history.
- A card that is off-screen, piled or hidden plays its effect at its open
  desk if any, else at a central spot. Pictures are skipped in a hidden
  window; sound still plays.
- The typing effects follow hard line breaks only. When a line soft-wraps,
  they land at the field's right edge on the line of the last hard break, on
  the canvas and in a pinned desk alike. The caret fix left this alone: the
  4.3.0 release cut asked for nothing new.
- Until the stage merges flashes (the next slice of the round), a flood of
  flashing events, such as several questions at once, can still flash more than
  three times a second, and the brown-out flicker (a usage limit, a dropped
  socket) dips the window dark up to five times in about a second.
- A wheel's effect waits for its outcome, so it starts one or two frames after
  the wheel (37 to 68 ms in the 30 frames-a-second capture) instead of at once.
  A scroll the page makes on its own within those six frames, such as a chat
  following its newest line as a message lands, counts as the wheel's.
