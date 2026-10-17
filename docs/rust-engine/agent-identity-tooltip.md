# Agent identity hover tooltip

Renderer agent links use the operating system's native title tooltip so a
reader can see which model and effort an agent uses without opening its desk or
settings.

## Behaviour

- The title contains the catalog display name (product, family and version),
  effort, and account separated by ` · `. The account appears only when the
  provider has multiple configured accounts or keys; it is the bound account
  name or `default` when unbound. Missing values are omitted.
- The browser supplies the native tooltip delay and presentation. The shared
  host resolves the current title on hover or focus, and clears it when the
  pointer leaves or a context menu opens. No custom tooltip overlay is mounted.
- A draft with a selected tier shows `(not started)` for effort. Archived
  agents show their last model with `(retired)`. Queued model switches are
  omitted.
- `agentNavProps(id)` marks links which already participate in delegated agent
  navigation/context menus. Surfaces with their own menu can use
  `agentTooltipProps(id)` to opt into the same tooltip without changing their
  menu handling.
- The canonical context menu's `Owner…` entry carries the owner's tooltip id,
  resolved by the same native tooltip host when hovered.
- The docket reply recipient Select keeps its MUI menu inside its
  `ObjectMenuBoundary` (`disablePortal`) so right-clicks reach the delegated
  agent menu. The shared context menu uses z-index 1600, above MUI popovers,
  dialogs and tooltips; the recipient regression checks it against the open
  popover layer.
- The renderer joins its existing `/api/providers` and `/api/accounts` reads;
  the tree projection does not grow. Static tier names and version names come
  from the Rust model catalog. Dynamic tiers retain their `name`/`label`; a
  missing catalog match falls back to the tree model id.

Implementation and focused coverage: `apps/desktop/renderer/src/canvas/agentnav.tsx`,
`apps/desktop/renderer/src/canvas/OrgCanvas.tsx`, and
`apps/desktop/renderer/tests/agenttooltip*.test.tsx`.
