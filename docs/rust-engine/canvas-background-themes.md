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
- **Grid/tile themes** are pure CSS gradient patterns in `styles.css`
  under `.canvas-bg[data-canvas-bg="…"]`. Patterns paint at full
  strength in the theme variables (`--canvas-dot`, `--line`, `--line-soft`)
  and the theme's intensity is the layer's CSS `opacity` — one colour
  source, one strength knob, identical compositing to mixing alpha into
  each colour. Sizes and positions are computed by `bgGeometry()` so
  patterns pan/zoom 1:1; `dots` keeps its legacy parallax values verbatim.
- **Flowing ASCII** is a `<canvas class="canvas-bg-ascii">` painted from
  pre-rendered glyph sprite sheets (5 brightness buckets × the 62-glyph
  pool). The model (`canvas/asciifield.ts`, pure math): glyphs are a seeded
  hash of the world cell (stable under pan/zoom, so the soup reads as a
  floor); brightness is a two-octave sine field — broad lobes (~900 world
  px) carrying curving bands (~280 px) — soft-thresholded so roughly half
  the plane is dark negative space that costs no paint. Tint is the theme
  accent mixed toward the dim ink, rebuilt when the visual theme changes
  (observed, debounced). Sampling is in world coordinates, so it pans/zooms
  like a floor; at far zoom-out (or huge windows) `asciiStep` coarsens the
  sampling instead of multiplying glyphs.
- **Motion discipline.** The ASCII loop runs at ~30 fps, reads the camera
  from `viewRef` (panning never re-renders it), pauses while the document
  is hidden or the canvas world is put away, and under
  `prefers-reduced-motion` renders one still frame repainted only by the
  user's own pan/zoom. DPR is capped at 2. Static themes have no loop at
  all and animate nothing.
- **EPIC Mode coexistence.** EPIC's stage is a fixed full-window overlay
  far above the canvas (`epic/stage.ts`, z-index 2147483000); this layer
  sits under `.space`. No shared state, no z-interaction — two
  independent, separately bounded painters.

## Performance

Background cost is **O(viewport), independent of organization size**. CSS
themes swap one `background-image` on an existing div whose style OrgCanvas
already updated every render for the dots: zero new renders, zero JS per
frame. The ASCII layer is bounded by `ASCII_MAX_CELLS` (16 000 sprite
blits worst case, typically far fewer because negative space skips) at
30 fps — measured in the visual fixture against the dot grid over the same
scene (see Evidence). Large-org live frame time is dominated by OrgCanvas
itself, which this change does not touch beyond the one layer swap.

## The ASCII reference, and what is interpretation

Researched 2026-10-15 by model-research-sol (screenshots and measurements
in `D:/orgtree-work/model-research/claude-code-ascii/`, public sources
recorded there). Measured from the reference: mixed-case Latin letters and
digits on a tight monospace grid (~193 columns across the app surface,
cell aspect about 1:2), very faint muted-blue ink on near-black, broad
rounded/lobed bright regions with large dark negative space, glyph rows
axis-aligned. **Not verified** (no public recording found): drift speed or
direction, whether glyph identities change, any activity coupling. The
slow drift here is therefore a labelled interpretation; every constant
that shapes the look (glyph pool, cell size, field wavelengths, threshold,
tint mix, frame rate) is in `asciifield.ts` / the top of the ASCII layer
so a better reference can be matched by constants alone. Hue follows the
Orgtree visual theme per ruling — the reference's steel blue is Claude's
own palette, not copied.

## Files

New: `packages/contracts/canvas-background.ts`,
`apps/desktop/renderer/src/canvasbgpref.ts`,
`apps/desktop/renderer/src/canvas/canvasbackground.tsx`,
`apps/desktop/renderer/src/canvas/asciifield.ts`,
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
  grid's legacy values pinned verbatim), field bounds/determinism/budget,
  rendered-layer selection per theme, reduced-motion flagging, and the
  real Display panel driving select + slider through a bridge stub running
  the real validator.
- Visual: `node tests/canvasbg-build.mjs` then
  `node_modules/.bin/electron tests/canvasbg-capture.cjs` — one PNG per
  theme (ASCII twice, to show the field's motion; plus zoom variants),
  receipts with computed-style probes and rAF frame-time stats for
  dots/ascii/ascii-panning/line-grid-panning. Outputs under
  `C:/orgtree-build/epic-wonder-full/canvasbg-visual/` (override with
  `CANVASBG_VISUAL_OUT`; a checkout without `node_modules` can pass
  `BATCH_NODE_MODULES` to both scripts and launch that tree's electron).
- Red control: branch `epic-wonder-full/canvas-background-themes-red`
  (integration points reverted to base with modules and tests retained) —
  see Evidence for the executed result.

## Evidence

Filled at hand-in with the exact SHA's measured runs (test counts,
typecheck, capture receipts, frame-time medians, red-control result) and
the PNG paths. Anything not measured is named in Limits instead.

## Limits

- Frame-time evidence is from the fixture (real layer and patterns over
  stand-in cards), not a live large organization; the O(viewport) argument
  is the structural guarantee.
- The ASCII motion (drift) is an interpretation — no public recording of
  the original's motion exists as of 2026-10-15.
- Both-on behaviour with EPIC Mode is argued structurally (independent
  layers/loops) and covered by the alpha; the fixture does not mount EPIC.
- Mobile keeps all canvas backgrounds off, as the dot grid always has.
