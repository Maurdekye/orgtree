# OpenCode owned mail plugin

The plugin, private transport and durable engine custody are implemented, but
**production activation remains disabled** until the offline lifecycle proof
lands. Only the synthetic rig can enable the pinned 2.0.28 path in this slice.
Ordinary production launches still use `plugins: []` and next-turn delivery.

The dependency-free asset is `runtime/opencode_mail_plugin.mjs`. When explicitly
installed by the engine, it registers `execute.after` through OpenCode's 2.x
plugin API. Only a successful versioned handshake enables the hook. Missing APIs,
an unavailable pipe, or a different protocol leave it inert.

## Private protocol

The engine supplies `ORGTREE_OPENCODE_MAIL_PIPE`, naming its process-scoped local
pipe or Unix socket. It is not an HTTP endpoint or a provider credential. Each
connection carries one newline-terminated JSON request and response:

| Request | Successful response |
| --- | --- |
| `{protocol:1, op:"ready"}` | `{protocol:1, ready:true}` |
| `{protocol:1, op:"claim", sessionID}` | `{protocol:1, batch:null}` or `{protocol:1, batch:{id, sessionID, text}}` |
| `{protocol:1, op:"ack", sessionID, id}` | `{protocol:1, acknowledged:true}` |

The engine must authenticate the listener's owning process, generation and
active session, apply DND and urgent filtering, and commit custody before
returning a batch. The plugin cannot choose a recipient or bypass those checks.
Claims must return the oldest unresolved batch before offering another.

A hook accepts completed and failed native tool results. Parallel callbacks
coalesce into one operation, with at most one batch per boundary. The request
is bounded to 4,096 bytes, response to 262,144 bytes, text to 128,000 UTF-8 bytes,
and a pipe operation or provider admission to 1,500 ms. No request, response,
mail body, or provider exception is logged.

The plugin calls `session.prompt` with the engine's stable message ID,
`delivery:"steer"` and `resume:false`. The latter avoids waking a new turn if a
hook races cancellation. It acknowledges only a response whose ID, session and
user-message type match. A timeout or failed acknowledgement does not retire
the batch locally. The engine must retain it for reconciliation.

## Durable identity and limits

OpenCode 2.0.28 checks a caller-supplied message ID against both its pending inbox
and promoted session history before preparing new input. See upstream
[`Session.prompt`](https://github.com/anomalyco/opencode/blob/026b106bc5d41b679ffc413264229c340871e4d3/packages/core/src/session/session.ts#L145)
and
[`SessionInbox.reconcile`](https://github.com/anomalyco/opencode/blob/026b106bc5d41b679ffc413264229c340871e4d3/packages/core/src/session/inbox.ts#L154).
Retrying the same ID in the same retained session therefore has a durable
deduplication mechanism. This is provider admission, not a model-read receipt.
Other versions need a verified compatible contract.

The engine stores one outstanding batch per agent in `ot.opencode_mail_batches`.
The actor previews eligible mail in ID order and formats a bounded prefix.
It then rechecks eligibility/DND under row locks (urgent mail bypasses DND) and
atomically claims that prefix with its provider ID, session, generation, turn
and transcript, before exposing it to the plugin.
Retries return that stored identity and text. A matching acknowledgement commits
the transcript, delivery states and removal of custody in one SQL statement.
Generic turn completion cannot acknowledge an outstanding batch.

Before closing a turn with outstanding custody, the engine stops the owned
OpenCode process and reads only ID/session/type from the isolated profile's
`session_inbox` and `session_message`. It uses read-only SQLite with WAL visible.
An exact user-message match proves admission; intact session/schema with neither
row proves absence. Missing, locked, changed or corrupt evidence is unknown.
After an unclean engine restart, absent proof that the old hosted writer stopped
is also unknown; this does not authorize reading an unrelated profile.

**Bounded uncertainty** (coordinator ruling 2026-10-20): unknown admission returns
the batch to ordinary delivery at the next turn, once, labelled **"may already
have been delivered mid-turn"**. One content-free diagnostic accompanies that
transition. It cannot remain silently held or re-enter the hook loop. Confirmed
admission deduplicates exactly; an irrecoverable evidence gap is explicitly
at-least-once recovery, not an unconditional exactly-once promise.

`node --test tools/rig/tests/opencode-mail-plugin.test.mjs` tests the shipped
asset, real local pipe framing and handshake, bounded failure, ordered batches,
racing hooks, and admission/acknowledgement retry. Its provider fixture models
durable first-admission-wins storage. It is **not** an engine database restart
proof, a DND implementation test, or a real OpenCode lifecycle proof. Those are
required before enabling the plugin.
