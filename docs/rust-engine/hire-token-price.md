# Hire-token seat-price order

User 2026-10-14 chose **within each provider row**, preserving separate provider
rows/columns and their inward-to-outward tier-count order. Tokens inside each
group now sort from cheapest to most expensive seat; equal prices keep the
incoming order. This supersedes descending hire-token order from October13.
Provider model lists and HireSheet lists retain their canonical listing order:
the most expensive seat first within each family, with Antigravity's
Claude-backed tiers grouped before Gemini tiers. Runtime OpenRouter and
language-server lists retain registry order. Default model selection still
uses declaration/offer order; the cheapest-first token-strip sort changes none
of these lists or defaults.

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
far-zoom strips, conditional/legacy gates and registry rows. Separate tests
cover canonical provider-list ordering and the unchanged default selection.

Measured in rig-opus round434 on 2026-10-14: the same 16 renderer cases run
against the exact base `cards.tsx` produce nine passes and exactly seven
token-order failures; the changed component passes 16/16 with no skips or
cancellations. Typecheck exits 0 under a 4096 MB/150 s kernel Job. The existing
far-zoom test's stale descending expectation was corrected separately in
`91a49c9`, and its collapse test passes in the combined renderer batch.
Receipts are `o5-red-green.log`, `o5-typecheck.log` and `r-union-434c.log` under
the batch434 evidence folder. The wider batch has three failures in other
cases and is not claimed clean. No installed or native visual proof was run.
