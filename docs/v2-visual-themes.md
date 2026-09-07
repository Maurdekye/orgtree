# Visual themes

App settings > Display > Visual theme offers Orgtree (neutral, the default),
Claude, Codex, Antigravity, and OpenRouter. The dark graph/desk layout, fonts,
spacing, provider badges and semantic status colors remain in place. This is
an application appearance preference; it does not select a provider, model,
account, route or permission.

The desktop saves `visualTheme` in its existing `desktop-settings.json`, outside
the engine's changing HTTP origin. Older preferences get the neutral default.
Invalid themes reject the entire preference update without writing it. The
renderer follows native preference events; an older initial read cannot undo a
newer event. The Display control reports a failed save and retains its previous
selection. Local browser fixtures use localStorage; this is not public browser
product support.

`packages/contracts/visual-theme.ts` lists accepted identifiers. Replace built-in
palette values in `renderer/src/themes.tsx`: `accent`, `hover`, and `soft` map to
`--accent`, `--accent-hover`, and `--accent-soft`; `--accent-ink` supplies dark
foreground text on these lighter application accents. Existing typography
(`--sans`, `--mono`), spacing and semantic/provider tokens remain in styles.css.
Provider-scoped CSS retains its existing accent overrides. Theme packages and
account tints are not part of this implementation.

Initialization applies the four root inline variables. The existing native
popout style observer copies those variables on opening and on later changes;
no alternate popout theme mechanism is introduced. Untrusted HTML presentations
retain their own styling and isolation.

Validation: `node --test tests/themes.test.mjs tests/desktop.test.mjs` covers
all persisted values, old settings, atomic invalid-update rejection, the actual
Display selector, native broadcasts, stale reads, and failed saves.
`node tools/test-themes-native.mjs` uses a fresh isolated profile and synthetic
content with the production Preferences, preload, ThemeSetting and PinFrame.
It selects every accent from an actual native popout and compares main/child
styles, font/background, panel dimensions, status/provider colors and a draft;
then redocks and reloads. It writes before/after PNGs and evidence.json to its
printed temporary directory. Chromium debugger screenshot capture is a fallback
when Electron capturePage reports UnknownVizError. Set ORGTREE_HISTORY_ELECTRON
to an explicit Electron executable if the local package has none. These are
component screenshots; assembled graph/desk review belongs to application
acceptance. No provider calls or live organization data are used.
