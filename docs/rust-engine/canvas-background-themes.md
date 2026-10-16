# Canvas background themes

The organization canvas's backdrop is selectable: **App settings > Display >
Canvas background**. The original dot grid stays the default and is
pixel-identical when nothing is stored. The themes are `dots` (the
original), `ascii` (flowing ASCII in the style of Claude Code's 2026 "New
session" backdrop), `line-grid`, `hex-dots`, `hex-lines`, `square-tiles`,
`triangle-tiles` and `hex-tiles`.

## Rulings this implements

- User 2026-10-15 15:52Z: allow the canvas background to be switched to a
  flowing ASCII-art style mimicking Claude Code's new UI. 15:57Z: add line
  grids, hex dot grids, hex line grids, square tile grids, triangular tile
  grids and hexagonal tile grids — a theme picker, current background the
  default.
- User rulings 2026-10-15 18:20Z (docket
  `optional-canvas-background-in-the-flowing-ascii-a`): the picker lives in
  **App settings > Display**; grids **pan and zoom with the canvas like a
  floor**; each theme has **one intensity slider** and uses the **current
  theme colours** (no per-theme colour pickers); the ASCII theme is
  **purely ambient** (activity coupling was not asked; ambient is the
  recorded default).
- Coordinator-confirmed readings (2026-10-15): the default dot grid keeps
  its 0.88 parallax (user feature 2026-09-03) untouched — only the new
  themes move 1:1; intensity is remembered **per theme**; mobile keeps
  canvas backgrounds off exactly as the dot grid always has been; the
  ASCII layer may clamp its sampling at far zoom-out.

## How it works

One component, `CanvasBackground`
(`apps/desktop/renderer/src/canvas/canvasbackground.tsx`), sits in the
exact slot the dot-grid div always occupied in `OrgCanvas` — first child
of `.canvas-world`, under `.space`, `pointer-events: none` — so
hit-testing, text selection and the pin layer are unaffected by the theme.

- **Preference.** `DesktopPreferences.canvasBackground?: { theme,
  intensities? }` (`packages/contracts/canvas-background.ts`), validated in
  `apps/desktop/main/policy.ts` by the contracts sanitizer, watched/saved
  through `apps/desktop/renderer/src/canvasbgpref.ts` (bridge broadcast +
  localStorage fallback, the EPIC-pref pattern). Absent = dot grid at full
  strength; a corrupt value resolves to the dot grid. Intensities are
  stored sparsely — only themes the user actually adjusted — so default
  changes still reach untouched themes. The slider saves debounced (one
  write per drag, like the custom theme colour) with an optimistic preview.
- **Grid/tile themes** are CSS patterns in `styles.css`
  under `.canvas-bg[data-canvas-bg="…"]`. Patterns paint at full
  strength in the theme variables (`--canvas-dot`, `--line`, `--line-soft`)
  and the theme's intensity is the layer's CSS `opacity` — one colour
  source, one strength knob, identical compositing to mixing alpha into
  each colour. Sizes and positions are computed by `bgGeometry()` so
  patterns pan/zoom 1:1; `dots` keeps its legacy parallax values verbatim.
  Gradients draw four themes; the two hexagon themes are SVG masks over a
  theme-colour fill, because gradient stripe families draw the whole
  triangular lattice and cannot select flat hexagons or their outlines
  (measured as diamonds, cube illusions and step columns across capture
  rounds) — their mask size/position ride the same `bgGeometry()` math.
- **Flowing ASCII** is an independent WebGL2 re-implementation of the
  Claude Code desktop "New session" backdrop algorithm, matched exactly
  (see the exact-match section below). A wind pass renders a field texture
  (light strength, wind direction, calm gate) at one sample per cell
  column and two per row; a glyph pass draws one quad per grid cell,
  clipped to the glyph's tight ink box, shaded by the field and by how
  the glyph's edges face the wind. Each mount draws a seeded "visit"
  (wind heading, speed, gust size, bend, and one of three glyph pools);
  cells cycle pool glyphs at their own hashed pace. The host element's
  computed `color` is the ink (CSS: `var(--dim)`), its `font-family` the
  glyph font (`var(--mono)`), and the per-theme intensity is the
  algorithm's strength scale (1.0 = reference presentation). Pointer
  motion stirs warm wakes; clicks launch ripples, every third in a heart
  shape — listeners are passive and ignore cards/interactive elements, so
  canvas selection is unaffected. Sampling is in **world coordinates**
  (it pans/zooms like a floor; at view 0,0 zoom 1 frames coincide with
  the reference's pane-anchored original). Where WebGL2 or a hardware GL
  pipeline is unavailable, under `prefers-contrast: more` or forced
  colours, or below a minimum grid, the layer simply does not appear.
- **Motion discipline.** The ASCII scheduler mirrors the reference's: a
  `setTimeout`→rAF loop over accumulated animation time with clamped
  frame deltas, a 180-second power budget after which the wind itself
  slows and the reveal fades to calm (loop parked, zero ongoing cost),
  wake on visibility/focus/pointer/keys, late-frame and GPU-fence fault
  strikes backing off to 83 ms frames then a doubling retry, and full
  pause while the document is hidden or the canvas world is put away.
  Under `prefers-reduced-motion` it renders still frames only, repainted
  by the user's own pan/zoom or a theme change. It reads the camera from
  `viewRef`, so panning never re-renders React. Static themes have no
  loop at all and animate nothing.
- **EPIC Mode coexistence.** EPIC's stage is a fixed full-window overlay
  far above the canvas (`epic/stage.ts`, z-index 2147483000); this layer
  sits under `.space`. No shared state, no z-interaction — two
  independent, separately bounded painters.

## Performance

Background cost is **O(viewport), independent of organization size**. CSS
themes swap one `background-image` on an existing div whose style OrgCanvas
already updated every render for the dots: zero new renders, zero JS per
frame. The ASCII layer's grid is capped by a 21-megapixel device budget
(and refuses tiny panes), the wind pass costs one fragment per field
sample, the glyph pass one small quad per cell with an unseen-cell cull,
and the power budget settles it to complete idleness after ~3 minutes —
measured in the visual fixture against the dot grid over the same scene
(see Evidence). Large-org live frame time is dominated by OrgCanvas
itself, which this change does not touch beyond the one layer swap.

## The ASCII exact match: sourcing, adaptations, proof

The user required a perfect match to the real Claude Code backdrop
renderer (2026-10-15 19:55Z) and chose to source the exact behaviour by
reading the real code, accepting the terms-of-service consideration. The
chain, all under the rules recorded in the docket item (read-only study,
prose/math notes only, no Anthropic code copied into repo, docs or tests,
independent reimplementation, supplied/downloaded references deleted when
done): the renderer was absent from the installed CLI 2.1.292 binary and
from the desktop app 2.42304.0 package (which loads its UI from claude.ai;
the downloaded installer was unpacked read-only, never run, and deleted);
an anonymous claude.ai fetch stopped at the bot wall as instructed; the
user then supplied the renderer chunk from their own session. That chunk
was studied in full and reduced to a prose/math specification (grid
sizing, glyph atlas and pools, seeded visit draw, PCG/value/gradient
noise, the wind-field composition, tap ripples and heart, pointer wakes,
glyph choice and shading, scheduler and power budget). `asciifield.ts`
implements that specification as pure functions **plus a CPU mirror of
the field/glyph math**; `asciigl.ts` is an independently written WebGL2
pipeline expressing the same math; `AsciiLayer` mirrors the lifecycle.

Approved adaptations (coordinator, 2026-10-15 21:25Z) — the only places
Orgtree diverges from the reference's semantics:

1. **World-coordinate field**: the reference samples its pane's CSS
   pixels; Orgtree samples world units so the backdrop pans/zooms like a
   floor per the 18:20Z ruling. At view (0,0, zoom 1) the two coincide;
   the calm ellipse stays screen-centred via a per-frame uniform.
2. **Full pointer interaction** (stir, ripples, every-third-tap heart),
   with exclusions on Orgtree cards (`.sq`) and interactive elements;
   listeners are passive, so selection and clicks are unaffected.
3. **Intensity slider = strength scale**, default 1.0.
4. **Ink = the host's computed colour** (Orgtree's muted text); glow
   colours are the algorithm's per-scheme constants, scheme from the
   computed `color-scheme`.
5. **Per-mount crypto seed** with an Orgtree look-history storage key;
   pinned seed/pool exist only as a test prop.
6. **Proof**: seeded numerical comparison (GL wind-texture readback vs
   the CPU mirror at pinned seed/time, in the visual fixture) plus
   pinned captures; unit goldens pin every derivation (hashes, draw
   order, noise, field, touch, glyph choice). No supplied file was ever
   executed.

Also proved in the fixture: the 180 s settle-to-calm and the
hidden-window pause bring the loop (and with it GPU/CPU work) to idle,
reduced motion yields the still mode, and canvas clicks still reach
cards normally with ripples purely visual (see Evidence).

## Files

New: `packages/contracts/canvas-background.ts`,
`apps/desktop/renderer/src/canvasbgpref.ts`,
`apps/desktop/renderer/src/canvas/canvasbackground.tsx`,
`apps/desktop/renderer/src/canvas/asciifield.ts`,
`apps/desktop/renderer/src/canvas/asciigl.ts`,
`apps/desktop/renderer/src/canvas/canvasbgsetting.tsx`,
tests `canvasbg.test.tsx` + `canvasbg-setting.test.tsx`, visual fixture
`canvasbg-visual.tsx` + `canvasbg-build.mjs` + `canvasbg-capture.cjs`,
this doc. Edited: `packages/contracts/index.ts`,
`apps/desktop/main/policy.ts`,
`apps/desktop/renderer/src/canvas/OrgCanvas.tsx`,
`apps/desktop/renderer/src/canvas/accounts.tsx`,
`apps/desktop/renderer/src/styles.css`, `AGENTS.md` (landing entry).

## Verification

- Unit/component/panel tests: `node tests/run.mjs canvasbg` (from
  `apps/desktop/renderer`). Includes native validation through the real
  `preferencesPatch`, resolver defaults, floor geometry (with the dot
  grid's legacy values pinned verbatim), ASCII spec goldens (seeded draws,
  PCG/noises, heart, grid sizing, atlas/pools/sequences, field mirror,
  touch, glyph choice), rendered-layer selection per theme,
  reduced-motion flagging, and the real Display panel driving select +
  slider through a bridge stub running the real validator.
- Visual: `node tests/canvasbg-build.mjs` then
  `node_modules/.bin/electron tests/canvasbg-capture.cjs` — one PNG per
  theme (ASCII twice, to show the field's motion; plus zoom variants),
  pinned-seed ASCII scenes (wind-texture numerical comparison at two
  field times, tap ripple, heart, card-vs-floor clicks, hidden pause,
  reduced-motion still, budget settle-to-calm), receipts with
  computed-style probes and rAF frame-time stats for
  dots/ascii/ascii-panning/line-grid-panning. Outputs under
  `C:/orgtree-build/epic-wonder-full/canvasbg-visual/` (override with
  `CANVASBG_VISUAL_OUT`; a checkout without `node_modules` can pass
  `BATCH_NODE_MODULES` to both scripts and launch that tree's electron).
- Red control: branch `epic-wonder-full/canvas-background-themes-red`
  (integration points reverted to base with modules and tests retained) —
  see Evidence for the executed result.

## Evidence

Measured 2026-10-15 under the machine lock at branch tip `d4ac686`
(implementation `81f606f`, tests/fixture/docs `df4ca22`, pattern fixes
`d4ac686`; this doc's evidence commit follows on top):

- Typecheck: root `tsc --noEmit` exit 0. Strict renderer
  (`apps/desktop/renderer/tsconfig.json`) and strict tests
  (`tests/tsconfig.json`) each report 29 diagnostics, **none in files this
  change touches** — the same count as the base's known baseline.
- Tests: `node tests/run.mjs canvasbg` → **19/19 pass**. Neighbours
  (`epicmode appsettings theme rainbow`): 87 pass / 1 fail — the failure is
  `epicmode-engine`'s playbook test timing out at 10 s plus its cascade,
  **identical at base `f1eed04`** (measured: 14 tests, 12 pass, same
  timeout), so it is pre-existing in this environment, not a regression.
  Root neighbour `tests/unix-boot-engine.test.mjs` (imports
  `main/policy`): 15 pass, 0 fail, 8 skipped.
- Captures: all 15 scenes PASS (`receipts.json`), every PNG personally
  inspected: dots, line grid (z=1 and z=1.8), hex dots, square checker,
  triangles, honeycomb outlines, hexagon tiles, ASCII at two times and
  zoomed out. Three pattern geometries were found wrong by the first
  capture round and fixed (triangles → single conic; hexagons → SVG
  masks); the final shots are the ones inspected. Frame times over 180
  rAF frames (Session-0 Electron, same scene): dots median 9.9 ms, ASCII
  10.9 ms, ASCII while panning 10.4 ms, line-grid panning 10.7 ms;
  p95 ≤ 19.5 ms throughout — no regression beyond ~1 ms of noise.
  Outputs: `C:/orgtree-build/epic-wonder-full/canvasbg-visual/`
  (`shots/*.png`, `receipts.json`), logs in `../canvasbg-logs/`.
- Executed red control: branch
  `epic-wonder-full/canvas-background-themes-red` at `37175dd`
  (integration files byte-identical to `f1eed04` by empty diff; modules
  and tests retained) → **19 executed, 13 pass / 6 fail**, the failures
  exactly the integration assertions: 3 Display-panel tests, 2 native
  validation tests, 1 stylesheet test.
- Source audits (`python tools/source-audits.py`): **FAIL at tip and at
  base identically** — `tests/test_hub_isolation.py` (25 tests, 6 errors)
  on `f1eed04` unmodified. Pre-existing; this change adds no audit
  failures and touches no Python.

### Exact-match phase (2026-10-16, on top of `3783926`)

Measured under the machine lock at the exact-match commit (this doc's
evidence lands with it):

- Typecheck: root `tsc --noEmit` exit 0. Strict renderer and strict tests
  each report **29 diagnostics — the base baseline count, none in files
  this phase touches**.
- Tests: `node tests/run.mjs canvasbg` → **24/24 pass** (19 before; the 3
  approximation-era field tests replaced by 8 spec-golden suites).
  Neighbours (`epicmode appsettings theme rainbow`): 87 pass / 1 fail —
  the same pre-existing `epicmode-engine` 10 s playbook timeout as at
  base. Root neighbour `tests/unix-boot-engine.test.mjs`: 15 pass, 0
  fail, 8 skipped.
- Captures: **all 23 scenes PASS** in one run (`receipts.json`); the
  ASCII PNGs (live at two times, zoom-out, pinned t=8/t=40, tap, heart,
  still, calm) were personally inspected — the heart ripple and the
  lobed flowing mass match the researched reference's structure; the
  settled-to-calm frame is blank floor as specified.
- **Numerical proof:** at pinned seed 42 / pool mixed / view (0,0,1), the
  GL wind-texture readback vs the CPU mirror over 12 972 samples at field
  times 8 s and 40 s: **every channel (strength, direction GB, gate) has
  max |diff| = 1/255 and mean ≤ 0.033** — i.e. the shaders and the spec
  agree to fp32/unorm rounding. Unit goldens pin the derivations the
  mirror and shaders share (hashes, visit draw order, noises, heart,
  grid, pools, touch packing, glyph choice).
- Behaviour proofs in the same receipts: card click delivered to the
  card with **no** ripple, empty-floor click ripples; hidden window →
  animation/field time **do not advance at all** for 800 ms (loop
  rAF-starved, GPU/CPU idle), resume on show; `prefers-reduced-motion`
  → still mode (single drawn frame, no loop); budget=2 s pin → settles
  to `calm` with reveal 0 and the loop parked. Frame times over 180 rAF
  frames: dots median 7.6 ms, ASCII 7.6 ms, ASCII panning 7.7 ms,
  line-grid panning 7.6 ms — **no measurable delta** at this fixture's
  vsync-bound rate.
- Two real finds from the proof, fixed before hand-in: the wind pass
  initially drew with blending enabled (direction channels smeared
  across frames — caught only by the readback comparison), and the
  capture harness needed fresh windows + CDP focus emulation on this
  GPU-contended machine. Source audits unchanged (same pre-existing
  `test_hub_isolation.py` errors=6 as base). The user-supplied renderer
  chunk was deleted after the proof, per the rules.

## Limits

- Frame-time evidence is from the fixture (real layer and patterns over
  stand-in cards), not a live large organization; the O(viewport) argument
  is the structural guarantee.
- The exact match is to the studied algorithm's mathematics as
  transcribed into the prose/math specification; the GL-vs-mirror proof
  binds the shaders to that spec to 1/255, and unit goldens pin the
  spec's derivations — but pixel identity with a running Claude desktop
  (its exact font stack, rasterization and compositor) is not claimed:
  glyph rasterization necessarily follows Orgtree's mono font. The
  world-coordinate adaptation also diverges from the reference's
  pane-anchored original whenever the canvas is panned/zoomed, by ruling.
- Both-on behaviour with EPIC Mode is argued structurally (independent
  layers/loops) and covered by the alpha; the fixture does not mount EPIC.
- Mobile keeps all canvas backgrounds off, as the dot grid always has.
