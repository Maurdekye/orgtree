# Hire-token seat-price order

User 2026-10-14 chose **within each provider row**, preserving separate provider
rows/columns and their inward-to-outward tier-count order. Tokens inside each
group now sort from cheapest to most expensive seat; equal prices keep the
incoming order. This supersedes descending hire-token order from October13.
Model selectors, hire-sheet dropdowns and default model selection stay unchanged.

`SpawnChips` filters the existing offer/legacy/conditional gates, then stably
sorts that copy by `seatOf`. This is the same catalog-backed seat lookup those
tokens already use for disabled tooltips; the regular token reads the same
`seats`/shared registry prices. Canvas and Quick chat callers supply the engine's
`TreePayload.tiers`, while registered OpenRouter/Language Server rows come from
the providers payload. No separate price table or dollar-rate sorting is added.
Registry ties keep registry order. All switchboard, node bottom/top/coworker,
far-zoom expanded and Quick chat strips share this component.

Icons, colours, tooltips, click/drag dispatch, family placement and availability
are unchanged. Focused tests exercise changed catalog prices, equal-price ties,
all four strip orientations, action/tooltip identity, price refresh, disabled
far-zoom strips, conditional/legacy gates and registry rows. Existing descending
selector/default tests remain controls. Typecheck passes. Red/green controls
will run in one rig-opus batch; no renderer runtime or installed proof is yet claimed.
