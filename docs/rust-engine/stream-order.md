# Live conversation order and thought spacing

The desk used to keep a completed streamed reply in its separate draft area
until an HTTP transcript refresh arrived. That area is below live thinking and
saved tool rows. A following thought or tool could consequently appear above
the earlier reply. The next reply could also replace that retained draft before
the fetch returned. Claude Code (including language-server agents) and Codex
shared this renderer path.

The actor now includes `convo_rows` in non-token stream frames: only successfully committed,
sanitized conversation rows since its previous frame, with their durable
`row_id`, `seq` and `convo_revision`. Full tool inputs stay in the separate
database column; they never enter this queue. The actor-owned queue coalesces
amendments by sequence and holds at most 128 rows. An exceptional larger batch
still exists in the transcript and is recovered by the normal refresh.

`draft_clear` and `thinking_clear` retire consumed partials in the same renderer
update that installs their replacements. Old engines retain the original
fallback path. The renderer retains stream commits until an actual fetched row
acknowledges that revision. Rows carried forward locally while merging a cursor
page are not acknowledgments. After a cursor merge, Rust rows use their canonical
sequence order, carrying sequence-less cards/ghosts after their preceding
sequence-bearing row (leading ones stay leading); an overlapping page must not append an earlier reply after newer
streamed rows. A fetch issued before the latest stream frame cannot resurrect
the frame's retired transient rows.

Claude's `content_blocks` uses UTF-16 start/end offsets into the existing text
and thinking fields (no copied prose), preserving native block order inside a single API
message, including text/tool/text. Tool blocks refer to existing chips by id,
so later results update the same chip without copying its input. Older stored
rows keep the legacy display layout. Codex starts a separate tool row when its
previous row already contains reply text.

Live thought bodies and expanded saved thoughts use the same component and CSS.
The old live root used `white-space: pre-wrap`, preserving Markdown's HTML
separator newlines between paragraphs as additional blank lines. The shared
thought body keeps those separators collapsed, while preserving the intended
single and double newlines inside the text.

## Verification

`tools/rig/proofs/stream-order.mjs` and `desktop/stream-order.cjs` drive the real
engine, PostgreSQL and renderer through scripted Claude Code and Codex CLIs.
A third agent uses the scratch llama.cpp provider with the scripted Claude
Code harness. Chat HTTP responses are delayed 2.5 seconds while websocket
frames continue. The proof captures screenshots, live/final DOM order, reply
counts, paint samples and thought HTML/line/block metrics. Additional cases
cover Claude records sharing one API message id and Codex text/tool/text.
No real model inference, live agent or live database is used.

`apps/desktop/renderer/tests/streamorder.test.tsx` checks stale HTTP snapshots,
overlapping cursor pages, tool revisions, atomic partial retirement, final
deduplication, and native block order. TypeScript checking and an engine debug
build accompany the rig proof. Results and source revisions are recorded on
the docket item `streamed-reply-text-shows-after-the-thought-tool`.

## Simultaneous partials and request rate (alpha.8 follow-up)

A remaining path ordered HTTP partial snapshots as draft then thought, while
websocket-only partials were rendered in separate thought then draft buckets.
A snapshot arriving while both were pending could therefore reverse either
production order. Each actor now gives a partial a small per-turn ordinal when
it first streams. Tokens carry only that ordinal, and HTTP partials carry the
same value and are sorted by it. The renderer projects snapshots and current
accumulators into one live tail. A committed row still retires its partial
atomically with the replacement, as above. No prose is duplicated in storage.

Record-mode panel invalidations fire for every stream frame. The conversation
hook subscribed to those invalidations in addition to consuming the frame in
`ingestStream`, producing one chat GET per token. The duplicate hook is gone;
completed phases, turn events, focus and history recovery retain their normal
refresh paths. Token delivery alone does not issue HTTP requests.

`reasoning-order.mjs` uses the installed real Claude Code CLI, an isolated
fake llama.cpp Anthropic Messages SSE endpoint, lsproxy, and the real engine
and renderer. It emits thinking/text blocks in both orders, with 200 timed
token chunks per turn, and counts chat GETs. It uses no real model or user
server. `partial-order.mjs` separately delays native block completion so two
partials coexist across a focus-triggered snapshot, in both orders on Claude
Code, Codex and a scratch language-server lane. Both capture live/final DOM
order and screenshots. Normal block-by-block closure through the real CLI did
not reproduce the ordering inversion by itself; the delayed-completion
snapshot case reproduces it. The request storm reproduces through the real
CLI without delayed completions.
