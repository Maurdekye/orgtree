# Language Server Gold

The Language Server provider already used gold in its chats and tier badges, but
Appearance had no matching preset. The new `langserver` preset is labelled
**Language Server Gold** and reuses that existing `#cda206` accent. The user's
2026-10-11 10:49Z ruling was to keep the existing colour, not choose a new hue.

`THEME_ACCENTS.langserver` in `packages/contracts/visual-theme.ts` is the single
source for the gold. `applyTheme` publishes it as `--langserver-gold`, shared by
the existing provider and tier CSS. Hover (`#dab944`) and soft
(`rgba(205,162,6,.16)`) are derived by the existing custom-theme helper. The
account-tint family mapping now uses this accent rather than falling back to
Claude. The existing dynamic tier CSS already follows `--tier-langserver`.
The native tray/window preset map and its generated ICO include Language Server.

The existing light-surface provider text remains deep gold, `#4d3a02`, with white
fill labels. Tier identity stays gold in every contrast mode. Organization-theme
agent text uses the existing contrast-aware text derivation. Automatic initial
theme detection remains CLI-only, just as for OpenRouter; adding a server does
not change an existing user's implicit theme or their explicit choice.

## Measured colour separation

CIE76 Lab distance, using `deployreadycolor.test.tsx`'s measure and its floor of 18:

| Gold versus preset | ΔE |
| --- | ---: |
| Orgtree Grey | 78.16 |
| Claude Terracotta | 49.10 |
| Codex Teal | 90.47 |
| Antigravity Blue | 120.97 |
| OpenRouter Lavender | 118.43 |

| Gold versus status | Dark ΔE | Light ΔE |
| --- | ---: | ---: |
| Work | 109.45 | 110.47 |
| Review | 83.70 | 91.74 |
| Backlog | 80.61 | 82.59 |
| Approved | 111.81 | 120.07 |
| Deploy Ready | 135.02 | 127.95 |
| Done / OK | 63.16 | 64.74 |
| Warning | 33.51 | 37.24 |
| Bad | 69.42 | 68.61 |
| Ice | 88.91 | 94.63 |

Deep gold's closest status is light Warning at ΔE **20.76**. Its minimum distance
from either Deploy Ready colour is **87.97**. Both the preset gold and the
provider's existing light text pass the separation floor without changing hue.

## Measured contrast

Minimum WCAG contrast across each mode's bg, side, panel, panel-2 and input:

| Surface mode | Provider text | Text on provider fill | Gold preset agent text |
| --- | ---: | ---: | ---: |
| Charcoal | 5.43:1 | 7.35:1 | 5.43:1 |
| Light | 9.14:1 | 10.93:1 | 4.51:1 |
| Solarized Light | 8.43:1 | 10.93:1 | 4.51:1 |
| Obsidian Black | 7.34:1 | 7.35:1 | 7.34:1 |

The identity gold itself is unsuitable for body text on pale surfaces; the
existing deep provider ink and contrast-aware organization agent text handle
that. The new preset follows the other presets' accent semantics.

## Verification and limits (2026-10-11)

Measured: `npm run typecheck`; 28 renderer tests selected by `agentcolors contrast
deployreadycolor langserver`; 15 tests in `tests/themes.test.mjs` and
`tests/desktop.test.mjs`. Theme saves, reloads, failed saves and native preferences
are covered, as are all four contrast modes and Language Server organization
colour overrides.

Measured offscreen rig: `tools/rig/proofs/langserver-theme.mjs`, using the
localmodels-opus 4.2.0-alpha.7 (dev) engine and this worktree's rebased renderer.
A fake model catalog
created a real Language Server agent, its status tool reached the engine, its
gold tier border rendered, Appearance saved the preset, and the light provider
ink stayed deep gold. Screenshots and results are in
`D:\orgtree-work\rig\lstheme-sol\evidence\langserver-theme-20261011T105811`.
The rig reported its usual Electron development CSP warning, separately from
application errors (none); its processes were stopped after the proof.

Inferred from source and generated assets: native tray/taskbar appearance. The
offscreen rig does not run desktop main or display native select popups; the
screenshots show the selected settings control. No installer or running app was
changed. No Rust code changed or Rust rebuild was needed.
