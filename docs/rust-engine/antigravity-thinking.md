# Antigravity completed-step thinking (4.4.0)

The user accepted showing Antigravity thinking after each model step completes
(2026-10-17 17:10Z). AGY's stream-json currently removes thoughts even when its
native history stores them. This fallback adds ordinary collapsed thinking rows
before the matching response. Thinking-only steps are retained too.

The process captures its selected login home and resume/init conversation ID.
Only a DONE agent_response with that exact conversation ID and a nonnegative
step index can read history. The conversation must be a canonical UUID; the only
file opened is `.gemini/antigravity-cli/conversations/<id>.db` in that home.
The stream step index matches `steps.idx` without conversion. No other session,
latest-file search, profile fallback or trajectory-ID guess is permitted.

The reader opens SQLite read-only with `immutable=1`, zero busy timeout, on a
blocking worker, outside any PostgreSQL transaction. It queries one INTEGER
primary-key step and admits at most 2 MiB of protobuf payload. CortexStep field
20 contains the planner response; its field 3 is the thinking string. Raw thinking
and signatures are ignored, and redacted thinking is omitted. Text is capped at
20,000 UTF-8 bytes, matching existing transcript thinking bounds.

Missing/unavailable history, changed schema and malformed payloads skip safely.
One categorical diagnostic per process contains neither paths nor thinking.
All content-bearing helpers and the step handler are unlogged. A future native
`thinking` field wins over history, including an explicit empty/redacted value.

Migration 0028 adds an indexed receipt for each agent/conversation/step. The
receipt, thinking row and response row commit in one short transaction. A replay
or restarted actor sees the receipt and inserts nothing; its response-present
flag also suppresses result fallback when old text deltas were not replayed. A failed transaction
leaves no receipt or partial thinking row. Receipt rows contain no content.

## Limits and author verification

Immutable SQLite cannot see uncheckpointed WAL and cannot recover an active
rollback journal. The reader skips a nonempty WAL/journal rather than taking
locks or pretending that a stale checkpoint is current. No guessed status enum
or unverified trajectory_meta/cascade identity relation is used. Current-step
visibility on the installed CLI remains an alpha check, with the above safe
fallback when history is not available. No old transcript is backfilled.

The synthetic suite covers exact step/session matching, missing DB/schema,
invalid identities, bounded UTF-8 payloads, signatures/redaction, an exclusive
writer without read locks/waits, malformed protobuf, WAL/schema skips, native
stream preference and thinking-before-response rows. A disposable PostgreSQL
fixture exercises real receipt SQL across replay, writer reload and rollback.
The red controls at 603f621 executed on 2026-10-17 19:31Z: eight tests,
one pass and seven predicted assertion failures, raw Cargo exit101. The
independent red harness compiled in12.75s; the test run took0.11s.

At product source `dd8d2d0`, the full engine test binary compiled in 52.12s
under a 6144 MB kernel Job with Cargo `-j 2`. All 11 focused reader/ordering
tests passed in 0.15s (raw Cargo exit 0, no signal). The receipt test was
explicitly ignored in that run, then executed against a newly initialized,
disposable PostgreSQL cluster: one test passed in 0.04s (raw Cargo exit 0,
no signal). It verifies actual receipt SQL, thinking-before-response order,
replay after writer reload, atomic rollback and content-free returned errors.
The cluster shut down cleanly and left no postmaster PID file or own child.
No real history content is used in author tests.

The earlier 4096 MB attempt exhausted compiler memory before any tests ran;
its log and raw Cargo exit 101 are retained separately. The successful 6144 MB
retry began with 8.98 GiB free RAM. Aggregate build and installer output plus
a 3,000,000,000-byte reserve stayed below the decimal 100,000,000,000-byte
ceiling for both successful phases. Evidence is in the author's
`C:/orgtree-build/hubchat-jumplist-sol/agy-thinking/` directory (`red.log`,
`green.log`, `pg.log`, matching raw result JSON, and dated budget receipts).

The user switched the current 4.4.0 work to hardening on 2026-10-17 21:46Z:
rig-sol-b reviews this exact hand-in once, with at most one re-check after
fixes. The coordinator owns integration, the combined round and alpha.5.
Installed CLI history visibility remains unmeasured by these synthetic tests.

## Verbose logging correction

The first static review found that the nested `stamp(&mut body, seq)` call
still had `#[logged]`. Its argument serializer exposed private thoughts in
verbose engine logs despite the unlogged reader and receipt writer. The
correction makes this content-bearing identity helper `#[nolog]` too. Its
other callers, ordinary transcript append and update, also stop logging their
bodies through that helper. Sequence, row ID, event ID and persistence behavior
are unchanged. The JSON sanitizer and pending-row retention helpers on these
paths are already unlogged.

The regression captures the real `EngineLayer` output with verbose logging
enabled while writing actual PostgreSQL receipts, replaying/reloading them,
rolling back a rejected row, and doing ordinary append/update. It checks
thought and response canaries are absent and verifies the persisted content
and identity fields. A logged `parse_after` call is the positive control;
an empty or disabled capture cannot pass. Capture uses a test-local subscriber
and synthetic content, without opening application diagnostics or live data.

On red source `8fdabfc` rebased onto assigned `c89111b`, the test executed and
failed at the expected thinking-canary assertion: raw Cargo exit 101, no
signal, one failure, 45.69s compilation and 0.21s test time. The captured log
contains the positive control and leaked canary. The stamp-only green below
then verified that write-path correction before the retrieval extension.

The stamp-only correction at `ee13b79` passed all 12 focused tests, including
the real receipt write and verbose canary capture: raw Cargo exit 0, no signal,
45.46s compilation and 0.15s test time. The positive control was present and
both canaries were absent. This did not yet cover transcript retrieval.

The author then found that `convo::read` logged its serializable `Page`,
`restore_mail_notices` logged its mutable row slice, and HTTP `chat` logged
its JSON response. The coordinator and reviewer approved including these
paths in the same privacy correction. On `a28b74f`, with stamp already fixed,
the expanded real PostgreSQL canary test read the complete page and an
incremental update, verified their contents/cursor, then failed at the expected
thinking-canary assertion: raw Cargo exit 101, no signal, one failure,
45.56s compilation and 1.36s test time.

Those three content-bearing methods now use `#[nolog]` as well. This closes
their older ordinary transcript-text leak too. Querying, notice restoration,
page contents/cursors and HTTP response construction are unchanged; ordinary
HTTP request/response metadata logging remains. The canary runs the real
write, read and notice-restoration paths; the HTTP handler's change is the
logging annotation only, not an end-to-end HTTP execution claim.

The final correction was rebased cleanly onto stack-fix tip `9f53433` and
tested at `fd208d9`: all 12 focused tests passed, none failed or were ignored,
raw Cargo exit 0 with no signal. Compilation took 47.53s and tests took 0.21s
under the 6144 MB Job with Cargo `-j 2`. The captured real engine log contains
the verbose positive control, neither canary, and no stamp/read/notice-restorer
body events. Persisted identities, full-page contents/cursor and incremental
updates passed their assertions. The disposable cluster shut down cleanly.

The preflight measured 86,966,255,287 bytes of build/installer outputs plus
the 3,000,000,000-byte reserve, with 8.66 GiB free RAM. Raw logs/results and
captured traces are retained as `privacy-{red,green}` and
`retrieval-{red,green}` files in the evidence directory above. Migration 0028
is unchanged, and the 43 extracted tool builders are preserved. Subsequent
hand-in changes only update these verification notes and `AGENTS.md`; the
engine source remains the tested source. The one consolidated correction
goes to rig-sol-b and the coordinator for the single allowed re-check.
