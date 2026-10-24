# Muse thought timing

User ruling, 2026-10-24 18:09:52Z: include Muse thinking times with the same
display as Claude, using Muse's own reported boundaries; a missing start stays
unknown. This change has no new setting or action. Existing transcript readers
and thought expansion continue to apply.

`runtime/actor.rs` forwards the outer MSP item notification to the turn-owned
`runtime/muse_thinking.rs::Timing`. Only a matching session ID, turn ID,
reasoning kind and native item ID may begin or finish an interval. The actual
`item/started` begins it; an in-progress `item/updated` does not. A completed
notification or reported settled status ends it. Observations happen before
the handler's diagnostic/database awaits and use monotonic `Instant` values,
as Claude's boundary fallback does. This measures the reported item lifecycle,
not an independently observable quantity of model computation.

The first start and first completion are retained. Replayed starts cannot
repair a completion that arrived without a start, and repeated completions
cannot extend an interval. The map contains metadata only, holds at most 1,024
bounded native IDs and resets with the turn. No global cache or thought text
is kept in the clock. Invalid, absent and cross-session/turn identities supply
no time. Turn `durationMs` is never used to fill a missing thought duration.

The ordinary row retains finite nonnegative `think_secs`, including zero.
Same-ID revisions update that row while preserving its timestamp, readable
thinking and tool chips. An empty native reasoning item retains a sealed thought
marker; its measured duration does not imply readable text. Historical rows
without a measured duration are unchanged. The shared `ThoughtLine` provides
Claude's existing formatting, expansion and sealed display after reload.

Verification uses recorded/fake MSP item envelopes and deterministic observed
instants in the actual product module, plus the ordinary renderer component.
It exercises duplicate/update/replay, missing start, identity, interleaving,
bounded-state, zero and reload cases. No live Muse turn or provider
authentication is used; that remains a separate acceptance check.
