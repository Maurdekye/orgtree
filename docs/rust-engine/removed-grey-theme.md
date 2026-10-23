# Retired Grey preset migration (4.4.2)

USER2026-10-23 removes Orgtree Grey and migrates selected uses to Custom with
the same RGB. Its base accent in the assigned source was **#b6bdc8**, or
**rgb(182,189,200)**. Custom encodes that as **custom:#b6bdc8**. The old
light-surface text partner #4c5565 was not the base color and is removed with
the preset-specific CSS. Custom keeps its existing generic hover/soft/ink
derivation; it does not retain the removed light-only override.

Coordinator approved these exact cases after the source audit:

| Legacy stored value | Canonical theme | Provenance |
| --- | --- | --- |
| orgtree, explicit=true | custom:#b6bdc8 | true |
| orgtree, marker missing | custom:#b6bdc8 | true (existing legacy-choice rule) |
| orgtree, explicit=false | claude | false |

The last case was a desktop unset placeholder, not a selected theme. Fresh
preferences now store Claude+false. The renderer still chooses the first
installed CLI in Claude/Codex/Antigravity/Muse order, with Claude at first
paint and with no installed provider. No provider/default rule actually
selected Grey; the desktop's old sentinel refines the user's description.

The shared compatibility normalizer is used by main preference validation,
renderer legacy input and tray accent lookup. Main reads expose canonical
values without writing live files on startup; a later write persists them.
Incoming legacy writes normalize identically. Browser localStorage has no
provenance flag, so its saved old string is a choice and becomes Custom.
Invalid unrelated values still reject the whole preference patch atomically.

There is no engine/org/template/import/agent visualTheme field. The only
stores are desktop preferences and the browser-local compatibility store.
Onboarding reads the same preferences. Remaining old-id strings are
compatibility checks, migration tests, or signed history/baseline records.

Custom had used the Grey tray icon as a bitmap tint base. It is renamed to
orgtree-eye-tray-custom.ico with identical bytes; generation uses a custom
key. The neutral loading iris and not-ready grey icon retain their pixels.
The app/installer artwork is unrelated. The synthetic obsidian capture key
uses Claude now; Obsidian Black itself remains a background contrast family.
LMS Gold and Muse Eggshell retain their palette values; their old nearest-
neutral comparisons are historical measurements rather than live defaults.

Verification scope: red for all three legacy cases, one focused set of
migration/menu/light-contrast tests, TypeScript, glossary/preservation guards
and one synthetic theme-list capture. No live preferences, providers, native
mouse, installer build or app restart. New UI actions are not introduced;
the retained theme choice still uses existing preference APIs.
