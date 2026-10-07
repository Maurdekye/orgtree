# Transcript and mail NUL handling

2026-10-07: alpha.11 failed to persist Codex transcript updates containing U+0000
(NUL): PostgreSQL rejects that scalar in text and jsonb. Read-only inspection of
the reported 17:07Z ConvoWriter.update / Actor.on_codex_item log chain confirmed
NUL in the serialized transcript payload. No live content is reproduced here.

## Storage boundary

`util::pg_text`, `pg_json`, and the optional-value variants borrow clean inputs.
`pg_json_mut` cleans owned JSON in place, before `take_tool_inputs` separates the
desk body from full tool input/source. It removes actual NUL in nested strings
and object keys. If a cleaned key collides with an existing clean key, the clean
key wins. Literal backslash-u0000 text, newlines, emoji, and all other Unicode
scalars stay unchanged. Rust strings cannot contain malformed UTF-8 or lone
surrogates. Binary image bytes are not text and remain exact.

This covers live append/update across provider lanes, imported history, old
argument repair, full native tool-input caching, and tool-image text metadata.
Mail send cleans content, attachments, reply metadata and typed events; direct
transaction writers and legacy mail imports use the same helper at SQL insertion.
Inbound and outbound org-inbox content also uses the helper. Routing identities
are not rewritten. No schema change, live rewrite, or historical data recovery.

## A rejected row

Live tool-result amendments commit separately: `ConvoWriter::update_batch` logs
each failed row and attempts the rest. History replacement keeps its transaction
and uses a savepoint for each row, rolling back only the rejected insertion.
Tool-image batches continue after individual insert failures. Provider envelope
handling already catches an item error and continues the actor's receive loop.
Connection/transaction failures that prevent rollback still propagate; this is
not a durable retry queue. Rows that failed in older builds are not reconstructed.

## 3.x reference

The reference `origin/dev` transcript_records.py writes JSON strings to SQLite,
which did not impose PostgreSQL jsonb's NUL restriction. Its orgdb/codec.py also
explicitly preserves escaped NUL using `json` rather than `jsonb`. There was no
equivalent blanket NUL stripping to port. This fix follows the requested 4.0
strip-NUL rule; it does not claim byte-for-byte legacy NUL preservation.

## Verification

Scratch-only SAFE_START smoke uses production ConvoWriter append/update,
update_batch, history insertion, tool image storage, and mail::send. Its temporary
HTTP adapter is removed byte-for-byte after building and is never committed.
All fixture agents are halted; no provider is invoked. Exact results are recorded
in the docket hand-in. Live provider turns and complete legacy imports are not
exercised by this smoke.

Measured on the scratch engine: raw jsonb NUL rejection reproduced; append and
update retained all non-NUL content and full inputs; a forced CHECK failure in
the first live amendment did not block the next; a forced middle history row
failed while both neighbors committed; image text was cleaned and bytea retained
NUL exactly; mail content/attachments/event saved; clean helpers borrowed; a
colliding key kept the clean spelling. Ten controls passed including zero turns.
Private engine and PostgreSQL were stopped. No live writes or paid turns.
