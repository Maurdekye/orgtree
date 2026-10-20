# OpenCode owned mail plugin

OpenCode **2.0.28** receives mail between native tool calls through Orgtree's
bundled plugin. The engine checks both discovery and the running ACP handshake
for that exact version. Other versions, a missing plugin API, or an unavailable
private bridge retain ordinary next-turn delivery. Only this owned asset is
enabled; third-party plugins remain disabled. ACP itself is unchanged.

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
Generic turn completion cannot acknowledge an outstanding batch. Context-full
recovery's claim-return query also excludes it, preserving the provider identity
instead of replaying its text as ordinary input. Actor reconciliation precedes
turn-boundary recovery; a failed reconciliation prevents crossing that boundary.

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
proof, a DND implementation test, or a real OpenCode lifecycle proof.

## Measured offline proof (2026-10-20)

`node tools/rig/rig.mjs run tools/rig/proofs/opencode-mail.mjs --real-opencode <exe> --lifecycle` runs the
real engine and an explicitly supplied OpenCode 2.0.28 executable against
`tools/rig/opencode-synthetic.mjs`, a loopback model. Every profile and database
belongs to the fixture; it does not use live authentication or a provider.
The proof holds model requests open to observe mail before the original ACP
prompt completes, rather than inferring injection from a later transcript.

At proof commit `e8f7ff4`, the pre-change `1d5d3a4` engine passed six controls and
failed exactly three expected checks: ordered in-turn input, acknowledgement
before prompt completion, and urgent DND injection. The candidate passed all
18 lifecycle checks, including failed-ack retry with one native message and
one transcript row, cancellation reconciliation, and marked next-turn fallback
after an engine crash. The existing fake-ACP proof passed 16 checks on the
unsupported-version path. These used the default test stack; timings and raw
receipts are retained in the author hand-in.

Enabled-source validation at `5bf014d` repeated all 18 lifecycle and 16 fallback
checks successfully, plus 24 plugin tests, 22 identity tests, engine build and
workspace check, with the default stack. The identity regression first failed
at `8b8d818` on the old next-turn-only instruction. The build/check retain the
baseline's unused `HashMap` import warning in `domain/tree.rs`.

The crash proof explicitly waits for discovery before its next wake. The existing
startup auto-resume can race asynchronous OpenCode discovery and refuse a turn
as not installed; this proof does not establish automatic restart resumption.
Custody is released with its uncertainty marker before that next wake.
The diagnostic privacy assertion excludes only the existing `/api/rig/tool`
HTTP request logger's synthetic sender-input echoes, also seen on the baseline;
all bridge diagnostics remain checked. It does not claim all engine logs are
content-free.

There is no background mail polling and no automatic interrupt on new mail.
A turn with no further tool boundary receives mail on its next turn. A receipt
proves provider admission, not that the model read or obeyed the message.
