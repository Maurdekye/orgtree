# Retired list header badges

USER 2026-10-21 11:16Z: "also i want the retired card to look the same on both
agents and projects. make it a card that's in the same list of header cards on
both, clickable to open the retired list."

`RetiredBadge` is shared by the normal agent/project header badge lists and the
desk's retired-list link. It owns one count tooltip, click and context-menu
action, all opening the existing bounded retired picker. There is no separate
world-positioned retired label on agent/project cards. USER 2026-10-21
17:36:18Z: "also make the retired card the last in the list, not the first";
the grey retired chip follows all other agent/project header chips. There is no
extra history read
during layout, and no label drawn over an open project desk. The org root's
retired list remains reachable through the same badge; the eye has no normal
node-header badge list. The new specifically clickable retired badge supersedes
the earlier generic non-interactive map badge policy for this identity only.

The hidden-retired display setting, far-zoom exclusion, reveal/dismiss state,
watchdog positioning and lazy picker paging remain owned by their existing paths.
Tests measure real browser rectangles, hit targets and opening the correct
parent's picker, including counts 1, 624 and 9999. The new header-flow assertions
replace the former inset-overlay transform/z-index assertions.

USER 2026-10-21 11:21:24Z (md48634532487): "how about just shrink
everything (zoom it out effectively) on the cards so that eveything fits".
The shared `CardFace` measures the whole normal card face before transforms and
uniformly scales its heading, actions and badge list only when necessary. Fixed
card geometry and canvas furniture stay in place. Already fitting content has
scale 1; there is no scrollbar, clipping, ellipsis or card growth added by this
fit. An owning-window ResizeObserver remeasures late layout changes; measuring
pre-transform sizes prevents camera zoom or the previous fit feeding back into
the next scale. Mini cards and open/pinned desks retain their own layouts.
Browser checks include overflowing agent slot chips and a project with wrapped
watch, queue and retired badges, hit targets, native hover and opening the picker.

USER 2026-10-21 17:35Z–17:37Z reported long-name hover pills changing the
whole card magnification, on agents as well as projects. The fit measures only
the resting layout: `CardName` marks its absolute full-name copy as a transient
fit overlay; `CardFace` excludes that copy while reading scroll dimensions and
restores it synchronously before paint. The truncated name stays in layout.
Hover/focus and camera zoom do not change the fit; real content changes still
refit. Browser regressions measure rest/hover/leave for agent/project cards,
both zoom classes, crowded/unscaled faces, and fixed outer bounds.
