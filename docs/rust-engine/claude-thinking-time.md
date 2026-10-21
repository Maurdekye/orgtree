# Claude completed thinking duration

User 2026-10-21 20:48Z: the live Claude thinking clock was accurate, but finished
thoughts always showed “a moment”. The stream handler cleared the live thought
without recording any duration in the durable assistant row.

New Claude stream blocks retain monotonic elapsed seconds from the observed
`content_block_start` to `content_block_stop`. A final native thinking block is
an observed end when the partial stream omitted its stop. Stops freeze the clock:
later finalization or database work adds no time. Text/tool blocks, duplicate
starts/stops, another message and a replay cannot supply a different block's time.
State is private to the turn, bounded to 1,024 pending blocks and reset at a new
native message. No reasoning text enters timing state or logging.

The existing assistant write stores `think_secs` on each ordered thinking block.
Adjacent native blocks keep their existing single disclosure: their durations
sum only when every constituent block was measured; otherwise timing is unknown.
It also stores the existing row-level `think_secs` when there is only one thought,
for compatible readers. The renderer prefers block timing and uses old row timing
only for a single thought. The same collapsed disclosure and duration formatter
remain in use, including sealed reasoning and a real measured zero.

Old rows can show a time only if one was already recorded. There is no history
rewrite or backfill: an unmeasured thought retains “a moment”. A historical row's
creation timestamp is not a thinking start and cannot recover the missing time.

This changes display metadata, not an action; transcript reading remains available
through existing transcript tools. Tests exercise the shared Claude stream and
final-row methods with a deterministic monotonic clock, JSON reload, delayed
finalization, multiple/sealed thoughts, missing starts and missing stops.
