# Unfinished streamed responses

At every turn end, including process exit, interrupt, halt and actor shutdown,
the actor saves its nonblank text draft before taking the turn. Thinking buffers
are unchanged. OpenCode ACP text chunks are already durable; abnormal endings
mark those existing rows rather than appending another copy.

Retained rows use `assistant_state: partial` and an `interrupted` flag. They are
ordinary assistant text in the desk and HTTP history, and the transcript tool
exposes `incomplete` and `interrupted` booleans. The renderer labels the text
without folding it into a thought. Normal completed replies add no fallback.

A hashed harness/native-message identity binds a completion to its retained
row. Migration 0056 adds a partial unique index on that key and agent ID, so a
late completion does not scan historical rows. The original text's byte length
and SHA-256 prefix receipt validate extensions, including UTF-8 boundaries.
Completion updates the original sequence, removes its partial marker and keeps
the receipt for duplicate completions and actor restart. Equal text from another
message, harness or agent is not a duplicate. Claude reconciles only the matching
text block, preserving other blocks. AGY uses conversation/step identity;
late deltas received while idle extend the retained row until DONE settles it,
and repeated DONE events do not append another tail. A protocol that supplies
no full later content cannot recover unreceived text.

Private draft, receipt and completion helpers are unlogged. Text is not placed
in ordinary database-error diagnostics. Draft retention must run before the
common `take_turn` cleanup, and clearing a draft follows the committed write so
the stream frame hands over the durable row atomically.

Verification: a cheap source red for the tutorial's stop-without-completion
sequence; focused response/identity controls, an isolated PostgreSQL reload and
replay test, the renderer marker test, compile/typecheck and one synthetic desk
capture. No real provider interruption or live transcript write is required.
