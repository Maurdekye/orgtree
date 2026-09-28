# Orgtree 2.1.13

Claude Sonnet 5.5 is now available. New Sonnet hires and model switches to
Sonnet use Sonnet 5.5. Every Sonnet agent that already exists when this
version first opens an organization keeps running Sonnet 5: it is pinned to
version 5 in its configuration menu, where Sonnet 5.5 can be chosen at any
time. This includes a Sonnet agent that still carried a version from a tier
it used before (an Opus "5.5", for example). An organization with its own
custom Sonnet model ID is left unchanged.

A model version now resets to the tier's default when an agent switches tier.
Versions share names across tiers (Opus 5 and Sonnet 5), so a pinned version
carried across a switch would otherwise select the new tier's older model.

The managed Claude Code pin is updated to 2.1.284, whose model catalog lists
`claude-sonnet-5-5` (display name Sonnet 5.5, knowledge cutoff June 2026) as
the latest Sonnet. Claude Code 2.1.280 does not list it, but still runs it
(measured: it logs `unrecognized_model` and completes the turn on Sonnet 5.5). Sonnet 5.5 has Sonnet 5's API
pricing: $2 per million input tokens, $10 per million output tokens,
$2.50/$4 for five-minute/one-hour cache writes and $0.20 for cache reads,
with a 1M context window. The Sonnet seat stays two credits, and Sonnet 5.5
spends the standard Claude weekly limit like the other non-Fable tiers.

Source verified September 28, 2026: the model catalog inside the published
`@anthropic-ai/claude-code` 2.1.284 package.

This stable patch contains no private v3 prototype changes.
