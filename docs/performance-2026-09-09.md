# Organization and desk loading measurements

Measured during the September 9 corrective wave. The graph fix is in `df7e8d1`.
These results do not require a language or renderer rewrite.

## Organization graph

A read-only SQLite backup of the 396-agent organization was copied to a fresh
private data root. Provider processes and network connections were refused by
an explicit probe barrier. Three calls ran in one new Python process with
cProfile enabled; each result was also serialized separately.

| Graph handler | Before | After |
| --- | ---: | ---: |
| First call | 1,964 ms | 827 ms |
| Repeated calls | 1,263?1,305 ms | 145?177 ms |
| Repeated annotation | 1,199?1,218 ms | 78?80 ms |
| Payload | 1,223,723 bytes | 1,223,723 bytes |

Cache-status projection was reloading the organization 16 times per request to
construct agent credentials. The fix passes the generation from the already
loaded organization into credential construction. Tokens remain byte-identical,
and HTTP authorization still checks the current stored generation. Token
comparison, generation-change and real HTTP authority checks passed.

This is an isolated comparison on the same database snapshot. It excludes live
lock contention, browser rendering and data transfer. The first request also
creates private scratch directories; it is not a pure disk-cache benchmark.

## Desk history

The current native transcripts for two agents were copied into another private
fixture with the organization database. The same production history reader and
50-row pagination were used. Transcript lookup was explicitly redirected to the
copied files; imported archive replay and concurrent writers were excluded.

| Copied transcript | Parsed rows | First chat page | Repeated chat page | Agent-mail page |
| --- | ---: | ---: | ---: | ---: |
| 40.9 MB coordinator | 12,625 | 1,393 ms | 1,535?1,674 ms | 43?73 ms |
| 5.0 MB agent | 1,005 | 288 ms | 86?99 ms | 41?71 ms |

JSON serialization took 0.2?1.3 ms. Lock acquisition was below 0.003 ms in this
uncontended fixture. The large transcript exceeds the existing 32 MiB per-entry
projection-cache bound, so repeated reads still parse it. The smaller transcript
benefits from the cache. This explains an observed remaining cost; the memory
bound has not been increased merely to improve a benchmark.

## Installed baseline and renderer limits

Earlier read-only requests to installed build `45a33d6` measured graph responses
at 23.8?26.7 seconds for about 1.17 MB; an independent Node client parsed that
JSON in 3.6 ms. Two desk-chat requests took 3.9 and 7.4 seconds. Those live
measurements used an earlier 393-agent state with other work in progress, so
subtracting the isolated numbers above would not yield a valid lock-wait cost.

The real renderer and packaged Python passed isolated initial/restart lifecycle
checks. The small fixture's mounted-root/frame-opportunity measurements do not
measure a populated live graph's rendering cost. A double requestAnimationFrame
is a frame-opportunity proxy, not measured paint or proof of responsiveness.

## Recommendation and collection

Deploy the graph correction before considering a rewrite. Then capture the
remaining live graph and large-desk delays. The next focused improvement to
investigate is bounded paging or caching of large transcript projections, with
append, truncation and memory-limit behavior preserved.

The current evidence identifies repeated backend work, not a Rust/wgpu need.
Changing the UI framework would not itself remove repeated database loads or
full transcript parsing. Actual live renderer cost remains unmeasured.

For a process started with `ORGTREE_PROFILE_TIMING=1`, the authenticated
`GET /api/desktop/profile-timing` endpoint exposes a bounded 2,000-record
snapshot. Compare `instance` before comparing sequence numbers across reads.
The graph stages are sequential; history's `chat_read_ms` is nested inside
`history_work_ms` and must not be added again. Retrieval does not record itself.
The flag defaults off and is read at process import; this work did not enable
it on the installed engine or restart that engine.
