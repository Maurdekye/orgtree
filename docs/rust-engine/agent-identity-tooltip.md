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
- Node-link submenus (`Owner…`, `Presenter…`, `Project…`, `Sender…`) and direct
  links assemble their Copy mention and composer-scoped Mention prefix through
  `agentLinkMenuEntries`. They retain the same separators and rendered order;
  a real composer is required for Mention. Parent Focus and hover/Right
  expansion semantics stay unchanged. [decided: user 2026-10-21 06:48:13Z;
  verified: `canvas/{contextmenu,objectactions}.ts*`]
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
  User 2026-10-21 06:53:22Z explicitly confirmed this exception includes the
  project mini folder: it omits the name, while the normal folder and
  identity-less `Project…` submenu label still prefix it. This supersedes
  the mini-specific name prefix introduced during alpha.23 hardening.
- The docket reply recipient Select keeps its MUI menu inside its
  `ObjectMenuBoundary` (`disablePortal`) so right-clicks reach the delegated
  agent menu. The shared context menu uses z-index 1600, above MUI popovers,
  dialogs and tooltips; the recipient regression checks it against the open
  popover layer.
- The project card background uses the same lazy native-tooltip source as
  its name, just as an agent card does. An open embedded project desk leaves
  its content's own hover targets in charge. Normal identity-less folder
  marks still prefix the project name. [verified: `canvas/projectcard.tsx`;
  user link-consistency invariant 2026-10-21]
- Project facts use the same live feed and source as their header badges:
  the exact slot chip, event-listener/watch chips, and queue chip text, in that
  order, joined by ` · `. Multiple listener chips join with `; ` within the
  listener section, giving at most three category sections while the header
  stays unchanged (USER 2026-10-21 16:00:17Z: "Group in the tooltip"). No
  Project/retired label, summary, prefixes or extra counts are added (USER
  15:59:29Z). Paused/spent or unrelated dogs follow the badge exclusions. Identity-less links
  prefix the project name on its own first line; name-visible and far-zoom
  links omit that prefix. USER 2026-10-21 11:16:57Z asked for the name followed
  by slot/listener facts; 11:17:42Z (m044c37a6c76b) confirmed "okay, yes, leave
  out the name there" on name-visible links. `AgentNavHost` reads replacement
  tree leases/watchdogs at hover time, so all classes share current facts.
  [verified: `canvas/OrgCanvas.tsx`, `canvas/{slots,listeners}.ts`;
  tests: `projecttooltip.test.tsx`]
- Exception, USER 2026-10-21 15:56:03Z, 15:56:42Z and 15:56:49Z:
  "basically if no colored chips would be in its header". With no coloured
  slot/listener/watch/mail-queue chips, the tooltip is the project name alone
  on every surface and zoom, even if the name is already visible. Summary
  text, the grey retired badge, and enabled-but-empty ACK/listener settings
  do not count as chips. The card and hover both use `projectHeaderFacts`;
  projects with chips keep the preceding facts/name-class rule.
  [verified: `canvas/projectheaderfacts.ts`; tests: `projectnamefallback.test.tsx`]
- The renderer joins its existing `/api/providers` and `/api/accounts` reads;
  the tree projection does not grow. Static tier names and version names come
  from the Rust model catalog. Dynamic tiers retain their `name`/`label`; a
  missing catalog match falls back to the tree model id.

Implementation and focused coverage: `apps/desktop/renderer/src/canvas/agentnav.tsx`,
`apps/desktop/renderer/src/canvas/OrgCanvas.tsx`, and
`apps/desktop/renderer/tests/agenttooltip*.test.tsx`.
