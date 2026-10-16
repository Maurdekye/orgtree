# Agent identity hover tooltip

Renderer agent links share a delayed identity tooltip so a reader can see which
provider account and model an agent uses without opening its desk or settings.

## Behaviour

- After about 500 ms over an agent link, or when focusing it by keyboard, show
  the agent name, provider, model, effort and account. Leaving the link or
  pressing Escape hides the tooltip; scrolling and resizing reposition it.
- Missing values display as `Unknown`. A draft with a selected tier displays
  that model and `(not started)` for effort. Archived agents show their last
  model with `(retired)`. Queued model switches are omitted.
- `agentNavProps(id)` marks links which already participate in delegated agent
  navigation/context menus. Surfaces with their own menu can use
  `agentTooltipProps(id)` to opt into the same tooltip without changing their
  menu handling.
- The tooltip host reads identity from the current canvas node registry after
  the delay, and portals into its renderer document so canvas transforms and
  clipped panels do not clip it.

Implementation and focused coverage: `apps/desktop/renderer/src/canvas/agentnav.tsx`,
`apps/desktop/renderer/src/canvas/OrgCanvas.tsx`, and
`apps/desktop/renderer/tests/agenttooltip*.test.tsx`.
