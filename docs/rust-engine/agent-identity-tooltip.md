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
- When a shared agent/project link's visible label omits its identity (for
  example a model chip or a shared `Owner...`/`Presenter...`/`Project...` menu
  entry), the shared tooltip host prefixes the entity name on its first line.
  Labels that already show the name keep the existing tooltip without a
  duplicate name. Canvas card names use that same host and have no competing
  name-only `title`.
- Far-zoom agent and project cards reveal their names in the same floating,
  click-through label above the card layer on hover or focus. Their native
  tooltips omit the redundant name and retain the model/account or project
  details. Normal project icons and other identity-less links still prefix
  the name. Zooming out of the mini presentation removes the floating label
  immediately. [user 2026-10-19 17:21Z]
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
