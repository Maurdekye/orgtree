# Canvas background themes

The organization canvas's backdrop is selectable: **App settings > Display >
Canvas background**. The original dot grid stays the default and is
pixel-identical when nothing is stored. The themes (in picker order) are
`dots` (the original), `line-grid`, `hex-dots`, `hex-lines`, `checkerboard`
(the 2×2 square checkerboard), `square-tiles`, `triangle-tiles`, `hex-tiles`,
and `ascii` (labeled **Claude Waves** in the UI and placed last — flowing
ASCII in the style of Claude Code's 2026 "New session" backdrop; stored
`'ascii'` and `'claude-waves'` both resolve to `'ascii'`).

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
- User rulings 2026-10-16 09:00–09:07Z (docket
  `optional-canvas-background-in-the-flowing-ascii-a`):
  1. **Graceful degradation and automatic recovery under load:** **Claude
     Waves** must never freeze the canvas or leave a stale world-coordinate
     frame stuck to the viewport during pan/zoom or heavy outside GPU/CPU
     load, and must automatically recover when load subsides or after WebGL
     context loss/restoration.
  2. **Rename to "Claude Waves" (last option):** rename **Flowing ASCII** to
     **Claude Waves** and place it last in the picker; preserve backward
     compatibility for stored `'ascii'` settings and accept `'claude-waves'`.
  3. **Checkerboard (`checkerboard`) + gapped outlined tile presets:** keep
     the existing 2×2 alternating square pattern unchanged under its own
     theme **Checkerboard** (`checkerboard`), and rework `square-tiles`,
     `triangle-tiles` and `hex-tiles` so each tile is a separately outlined
     closed polygon inset from its mathematical tiling cell (`{4,4}`,
     `{3,6}`, `{6,3}`) with small even gaps and no shared edges.

## How it works

One component, `CanvasBackground`
(`apps/desktop/renderer/src/canvas/canvasbackground.tsx`), sits in the
exact slot the dot-grid div always occupied in `OrgCanvas` — first child
of `.canvas-world`, under `.space`, `pointer-events: none` — so
hit-testing, text selection and the pin layer are unaffected by the theme.

- **Preference.** `DesktopPreferences.canvasBackground?: { theme, version?,
  intensities? }` (`packages/contracts/canvas-background.ts`), validated in
  `apps/desktop/main/policy.ts` by the contracts sanitizer, watched/saved
  through `apps/desktop/renderer/src/canvasbgpref.ts` (bridge broadcast +
  localStorage fallback, the EPIC-pref pattern). Absent = dot grid at full
  strength; a corrupt value resolves to the dot grid. Intensities are
  stored sparsely — only themes the user actually adjusted — so default
  changes still reach untouched themes. Legacy unversioned `'square-tiles'`
  selections and intensities (from 4.3.1-alpha.1 before `'checkerboard'` was
  split out) automatically migrate to `'checkerboard'`, while new selections
  of the gapped outlined `'square-tiles'` preset carry `version: 2` (user
  ruling `mb271a07b3fce`). The slider saves debounced (one write per drag,
  like the custom theme colour) with an optimistic preview.
- **Grid/tile themes** are CSS patterns in `styles.css`
  under `.canvas-bg[data-canvas-bg="…"]`. Patterns paint at full
  strength in the theme variables (`--canvas-dot`, `--line`, `--line-soft`)
  and the theme's intensity is the layer's CSS `opacity` — one colour
  source, one strength knob, identical compositing to mixing alpha into
  each colour. Sizes and positions are computed by `bgGeometry()` so
  patterns pan/zoom 1:1; `dots` keeps its legacy parallax values verbatim.
  CSS gradients draw `dots`, `line-grid`, `hex-dots` and `checkerboard`
  (2×2 alternating conic-gradient squares at `2 * TILE * z`). `hex-lines`
  and the three gapped tile presets (`square-tiles`, `triangle-tiles`,
  `hex-tiles`) are SVG masks (`fill="none" stroke="white" stroke-width="1.5"`)
  over `background-color: var(--line)`: each tile preset draws every tile
  as its own closed polygon inset from its mathematical tiling cell so
  neighbouring tiles are separated by a small even gap and share no edges.
- **Claude Waves (`ascii`)** is an independent WebGL2 re-implementation of
  the Claude Code desktop "New session" backdrop algorithm, matched exactly
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
  the reference's pane-anchored original). At far zoom-out, world-space
  sampling clamps zoom at `z >= 0.35` (`worldScale = z * dpr`), while
  `gridFor` keeps `gridScale = Math.max(1, z) * dpr` (`cellWidth = 7` px at
  `dpr = 1`, `13` px at `dpr = 2`) and `buildAtlas` caches `AtlasData` per
  `(cellWidth, cellHeight)` so zoom-out never shrinks glyphs to faint 4 px
  sub-pixel strokes or triggers WebGL backbuffer/2D-canvas atlas rebuilds
  on every zoom step below `z = 1`. Where WebGL2 or a
  hardware GL pipeline is unavailable, under `prefers-contrast: more` or
  forced colours, or below a minimum grid, the layer simply does not appear.
- **Motion discipline and load resilience.** The ASCII scheduler mirrors
  the reference's: a `setTimeout`→rAF loop over accumulated animation time
  with clamped frame deltas, a 180-second power budget after which the wind
  itself slows and the reveal fades to calm (loop parked, zero ongoing
  cost), wake on visibility/focus/pointer/keys, and full pause while the
  document is hidden or the canvas world is put away. Under heavy CPU/GPU
  load, late frames (`> 100 ms` rAF latency), stalls (`> 500 ms` frame
  delta), or unsignaled GPU fences (retired on the 2nd consecutive check so
  a single slow fence cannot cascade indefinitely, with `slow` reset each
  draw) first step down to `83.3 ms` (~12 fps) backoff (`busy-late` /
  `busy-gpu` / `busy-stall`). On a second strike (`enterBusyOff`), the
  scheduler stops the loop, immediately fades `renderer.canvas.style.opacity`
  to `'0'` (`transition: opacity 250ms`) so a paused world-coordinate frame
  is never left frozen on screen while panning/zooming, and schedules an
  automatic recovery retry (`1500 ms` doubling up to `8000 ms`). It also
  handles `webglcontextlost` (`e.preventDefault()`, hides canvas, sets
  `dataset.state = 'context-lost'`) and `webglcontextrestored` (rebuilds GL
  programs, textures and framebuffers in place via `renderer.restore()` and
  resumes). Under `prefers-reduced-motion` it renders still frames only,
  repainted by the user's own pan/zoom or a theme change. It reads the
  camera from `viewRef`, so panning never re-renders React. Static themes
  have no loop at all and animate nothing.
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

### Resilience, Checkerboard, and gapped tile presets phase (2026-10-16, on top of `5efd8ae`)

Measured under the machine lock on branch `backdrop-argon/backdrop-fixes`:

- **Incident analysis (inferred vs measured):** Reading the session's engine diagnostics log (`2026-10-16_00-27-16.log`) showed no engine/IPC errors around 09:00Z. Because the absence of engine log errors does not by itself establish the runtime failure mode, the connection to outside game GPU/CPU contention (`m134ee5295e37`) is **inferred**, and a full app freeze was **not** reproduced without outside load. Source inspection and deterministic tests/captures **measured** four concrete renderer behaviors at `5efd8ae` that compounded zoom-out and GPU/CPU contention: (1) `computeLayout()` scaled `gridFor` down to `z = 0.05` (triggering uncached 2D canvas `buildAtlas` + `getImageData` rebuilds across zoom steps and returning `null` below `z = 0.42` at `dpr = 1`); (2) `asciigl.ts` kept unsignaled GPU fences at the head of the queue without resetting `slow = false`; (3) `enterBusyOff` stopped the rAF loop while leaving `renderer.canvas.style.opacity = '1'` and waited `60_000 ms` (`retryMs` doubling to `480_000 ms`), leaving a static world-coordinate frame visible on screen until the timer fired; and (4) `AsciiLayer` had no `webglcontextlost`/`webglcontextrestored` handling.
- **Red control:** executed against `5efd8ae` (`C:/orgtree-build/backdrop-argon/red-control/summary.json`) → **29 tests run, 20 pass / 9 fail**, with every new assertion failing red before the implementation commits: contract order/rename/alias + legacy `square-tiles` → `checkerboard` migration + v2 `square-tiles` (`2 fail`), CSS gapped SVG masks + checkerboard conic gradient (`1 fail`), `CanvasBackground` layer rendering for `checkerboard` (including legacy `square-tiles` migration) and v2 gapped tiles (`1 fail`), zoom-out grid/atlas bounding (`1 fail`), GPU fence retirement + load backoff hiding (`opacity: 0`) + fast auto-recovery (`1 fail`), real `WEBGL_lose_context` loss/restore + resource regeneration (`1 fail`), and Display panel picker order/labels/legacy migration (`2 fail`).
- **Typecheck and unit/component tests:** root `tsc --noEmit` exit 0; strict renderer and strict tests report **0 diagnostics in touched files** (`C:/orgtree-build/backdrop-argon/green-verify-final/summary.json`). `canvasbg` + `canvasbg-setting` suites → **29/29 pass (0 fail)**; renderer neighbours (`appsettings theme rainbow`) → **29/29 pass (0 fail)**; root neighbour `tests/unix-boot-engine.test.mjs` → **15/15 pass (0 fail)** (**73/73 total pass**).
- **Electron visual captures (`C:/orgtree-build/backdrop-argon/canvasbg-visual/`):** **all 26 scenes PASS (`receipts.json`)**, with every new/reworked preset and resilience scene inspected:
  - `checkerboard.png` (`distinct=33`, `checkerboardGradient: true`): 2×2 conic-gradient square checkerboard preserved unchanged.
  - `square-tiles.png` (`distinct=36`, `tileMaskApplied: true`, `maskSize: 28px 28px`), `triangle-tiles.png` (`distinct=37`, `tileMaskApplied: true`, `maskSize: 36px 62.35px`), `hex-tiles.png` (`distinct=37`, `tileMaskApplied: true`, `maskSize: 29.44px 51px`): each tile rendered as its own closed outlined polygon inset from its `{4,4}`, `{3,6}`, or `{6,3}` cell with small even gaps and no shared edges.
  - `ascii-drag-zoomout.png` (`dragZoomSteps: true`, `dragZoomCellBounded: true`, `dragZoomFast: true`, `dragZoomAlive: true`, `painted: true`): in `rig-sol-b`'s run at `67dda66` (`C:/orgtree-build/rig-sol-b/backdrop/visual-tip1/receipts.json`), `ascii-drag-zoomout` failed `painted` (`distinct = 10 <= 12`, floor pixel R histogram `[31..34]` vs `[31..59]` at `z = 1`) with `finalState.datasetState = "busy-gpu"` because (a) `gridScale = Math.max(0.75, z) * dpr` shrank `cellWidth` from `7` to `5` (`glyphPx = 4 px`, 5× lower sub-pixel glyph alpha and 3 WebGL backbuffer/atlas reallocations during the zoom-out), and (b) `api.drawAt()` ran inside the same `requestAnimationFrame` turn as `AsciiLayer`'s background `frame()` loop without `gl.flush()`, polling the same unsubmitted `WebGLSync` fence twice and triggering a 2nd-strike `enterBusyOff` (`opacity → 0` fade-out) during the post-stress `settled()` wait right before `capturePage()`. Keeping `gridScale = Math.max(1, z) * dpr`, calling `gl.flush?.()` on fence creation, and rescheduling the background timer on `drawAt()` keeps `cellWidth = 7` (`dpr = 1`), `datasetState = "moving"`, and full floor contrast.
  - `ascii-clicks.png` (`cardClickDelivered: true`, `cardClickNoRipple: true`, `floorClickRipples: true`): at both base `5efd8ae` and `67dda66`, `AsciiTestApi.state()` exposed only `touchBusy: touch.busy(now)` (which ORs `taps` and pointer-move `wakeRecs`) and `canvasbg-capture.cjs` checked `afterCard.state.touchBusy === false`. When an OS pointer move over the floor occurred during the 4000 ms settle before the card click, `wakeRecs` stayed active for `WAKE_LIFE_S = 2.4 s`, making `afterCard.state.touchBusy === true` even though clicking `[data-card="coordinator-opus"]` added zero tap ripples (confirmed visually in `rig-sol-b`'s `ascii-clicks.png`, where the blue ripple ring appears only at `(120, 120)`). Exposing `tapBusy: touch.rippling(now)`, `wakeBusy: touch.waking(now)`, and `tapCount` in `state()` separates pre-existing pointer wakes from card-click tap ripples.
  - `ascii-degrade-recover.png` (`distinct=42`, `degradedPaused: true`, `degradedHiddenNoFreeze: true`, `recoveredFromLoad: true`, `contextLossHandled: true`, `contextRestored: true`, `contextPostRestoreDraw: true`): 2nd-strike GPU load immediately pauses the loop and fades `renderer.canvas.style.opacity` to `'0'`, automatically recovers to `dataset.state = 'moving'` after the `1500 ms` retry timer (`1568 ms` measured), and exercises real `WEBGL_lose_context.loseContext()` (`gl.isContextLost() === true`, `readWind() === null`, `dataset.state = 'context-lost'`, `opacity = '0'`) followed by `WEBGL_lose_context.restoreContext()` (`renderer.restore()` rebuilds GL programs/textures/framebuffer, `drawAt(8, 1)` + `readWind()` / `__compareWind(8)` verify regenerated resources produce 12 972 samples, 3526 non-zero, max channel diff `1/255`).

### Minimum-zoom cursor alignment fix (2026-10-16, on top of `8d28b3d`)

- **Root cause (measured):** In `4.3.1-alpha.2` (`8d28b3d`), `computeLayout()` and `drawOnce()` in `canvasbackground.tsx` clamped `const z = Math.max(0.35, v.z)` while `toWorld(e)` converted pointer coordinates with the unclamped `v.z`. At desktop minimum zoom (`v.z = 0.24`, or circular-chart minimum zoom down to `1e-4`), a cursor at screen offset `sx = e.clientX - rect.left` produced world coordinate `X = (sx - v.x) / v.z`, which the shader rendered at screen coordinate `sx + (sx - v.x) * (0.35 / v.z - 1)`. Because the root desk (`@user`) sits near world `x = 6000`, `v.x < 0` (`sx - v.x > 0`), shifting pointer wakes and tap ripples `+45.8%` of `sx - v.x` (`~500–800 px`) to the right of the cursor until zooming in reached `v.z >= 0.35`. `bgGeometry()` for all CSS backdrops (`dots`, `line-grid`, `checkerboard`, `square-tiles`, `triangle-tiles`, `hex-lines`, `hex-tiles`, `hex-dots`) already used `view.x`, `view.y`, `view.z` directly with no `0.35` clamp.
- **Fix:** Replace `Math.max(0.35, v.z)` with `asciiZoom(v.z) = Math.max(1e-4, v.z)` across `computeLayout()`, `drawOnce()`, and `toWorld(e)` while keeping `gridScale = Math.max(1, z) * dpr` so glyph cell dimensions and WebGL backbuffer/atlas allocations remain bounded at the `z = 1` grid for all `z <= 1`.
- **Verification:**
  - Red test first (`C:/orgtree-build/backdrop-argon/offset-logs/red-canvasbg-test.log`): at `v = { x: -720, y: -180, z: 0.24 }`, a click at `clientX = 520, clientY = 240` rendered at `screenX = 1088.33 px` (`+568.33 px` right of the cursor), failing `28 pass / 1 fail`.
  - Green unit/component suite (`C:/orgtree-build/backdrop-argon/offset-logs/green-canvasbg-test.log`): **29/29 pass (0 fail)** across `canvasbg.test.tsx` and `canvasbg-setting.test.tsx`, verifying zero cursor offset (`< 1e-3 px`) for taps, pointer wakes, and calm center at `z = 0.24`, `z = 0.35`, and `z = 0.12`, plus `bgGeometry()` phase alignment across all CSS backdrops at `z = 0.24` and `z = 0.35`.
  - Electron visual captures (`C:/orgtree-build/backdrop-argon/offset-visual/receipts.json`): `ascii-tap-minzoom.png` (`z = 0.24`, click at `(520, 340)`, `distinct = 23`, `minZoomCursorAligned: true`), `ascii-tap-zoomstep.png` (`z = 0.35`, click at `(520, 340)`, `distinct = 27`, `zoomStepCursorAligned: true`), and `ascii-drag-zoomout.png` (`z = 1.2 → 0.15`, `distinct = 23`, `maxStepMs = 5.7 ms`, `minCellWidth = 7`, `nonZeroWind = 3696`, `dragZoomAlive: true`) all PASS.

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
