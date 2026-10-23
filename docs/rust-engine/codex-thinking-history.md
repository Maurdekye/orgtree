# Codex sealed thinking and agent transcript reads

Completed Codex reasoning items without readable summary/content now append a
normal assistant row with empty response/thinking text and `thinking_sealed:
true`. The existing desk renderer displays its sealed thought placeholder.
Readable native summaries keep the existing 20,000-character storage bound.
Ciphertext, fabricated reasoning, duration and token counts are not added.
This records new completed items; there is no historical sealed-row backfill.

The actor reuses the native item's row sequence for repeated completion receipts
within its turn. A later readable receipt replaces the marker; an empty replay
cannot hide an already supplied summary. Tool chips already attached to that row
survive updates. Codex rows keep the ordinary unordered form because later tools
attach there; adding only an ordered thinking block would hide those chips.

`orgtree_read_transcript` now projects supplied readable thinking for every
harness, independently capped at 1,200 Unicode characters per row. It reports
`thinking_truncated` and `thinking_sealed`; the latter recognizes both row flags
and sealed ordered thought blocks. A mixed Claude row may supply text and also
contain a sealed block. Existing role/prose/tool, incomplete/interrupted,
authorization, paging and activity metadata remain unchanged. No encrypted text
is recovered and no read starts a provider turn.

The constructor, native item handler and thinking projection are unlogged
content-bearing helpers. Tests cover source red controls, sealed/readable row
construction, same-item upgrades and tools, isolated PostgreSQL history reload,
all-harness projection shapes and Unicode bounds, plus existing renderer sealed
and readable thought forms. No real provider invocation is needed.

Verbose traces also redact supplied thinking in the shared JSON formatter.
Ordinary structured thinking fields are masked; thought blocks and JSON text
inside Done/MCP/legacy results are omitted when they contain thinking, including
nested encodings. Log-only decoding has size/depth bounds and fails closed.
Actual tool replies remain intact, with ordinary call/return diagnostics kept.
The captured-trace regression exercises Done.json and logged outer wrappers.
