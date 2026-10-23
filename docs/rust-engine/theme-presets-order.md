# Theme preset labels and order

The current menu order is Claude Terracotta, Codex Teal, Antigravity Navy,
Muse Eggshell, OpenRouter Lavender, LMS Gold, Custom. Settings Providers and
onboarding share PROVIDER_THEME_PRESETS; Custom is last. Theme ids remain
appearance values, separate from provider ids.

USER2026-10-14 renamed LMS Gold, Muse Eggshell and Antigravity Navy without
changing their stored ids or palettes. USER2026-10-23 removed Orgtree Grey
for4.4.2. Its old orgtree id is accepted only as migration input, never as a
preset. See [migration](removed-grey-theme.md) for explicit/unset provenance,
the exact custom RGB and the tray tint-base rename.

Fresh first paint/no-provider fallback is Claude. Installation-based provider
detection chooses Claude, Codex, Antigravity or Muse in that order. Explicit
choices win; they do not change provider routing. Historical round445 label
checks concerned the earlier seven-preset menu, not the current preset count.
Rainbow remains separate under [Custom](rainbow-custom-toggle.md).
