# Visual themes

App settings > Display > Visual theme offers Claude Terracotta, Codex Teal,
Antigravity Navy, Muse Eggshell, OpenRouter Lavender, LMS Gold, then Custom.
Settings Providers and onboarding share the provider preset order. This is
an app appearance choice, not a provider/model/account/permission selection.

An unset preference starts with Claude, then follows the first installed CLI
provider in Claude, Codex, Antigravity, Muse order; without a provider it stays
Claude. Explicit choices persist across reloads. The desktop stores visualTheme
and visualThemeExplicit in desktop-settings.json, independently of the engine
port; browser fixtures use localStorage.

Orgtree Grey was removed in4.4.2 (USER2026-10-23). A legacy selected orgtree
value becomes Custom #b6bdc8, RGB(182,189,200). True or missing provenance is
explicit; false was an unset sentinel and becomes Claude+false so provider
detection continues. Main preference reads/writes and browser local storage
normalize the old id silently. Invalid unrelated values still reject atomic
preference writes. The old light-surface partner #4c5565 is not the migrated
color; Custom retains its generic hover/ink behavior. No org/template/import
or agent theme field exists. See [migration details](rust-engine/removed-grey-theme.md).

Preset colors come from packages/contracts/visual-theme.ts and renderer
themes.tsx; styles.css retains deep partners for the six remaining presets on
Light/Solarized Light. Background contrast modes remain independent. Popouts
mirror root theme variables and attributes. Native Custom icons tint their
dedicated custom base; loading-grey artwork is unchanged.

The focused migration tests cover all three legacy provenance cases, reads,
writes, canonical reload, browser migration and actual Custom controls. The
existing lightaccent checks retain contrast coverage for every remaining
preset. Phase1 includes a failing migration control, one focused run,
typecheck and a theme-list capture; installed native acceptance is separate.
