# On-demand usage query: audit and proposed contract

Contract approved through lead-astra, 2026-10-11 22:35Z. Source implementation
and verification are in progress; approval is not evidence of a passing build.
Ticket: `agents-can-query-usage-statistics-on-demand`.
Source audit base: local `rust-engine` at `89268b7`.

Agents receive a usage snapshot only at a turn boundary. Add `orgtree_usage`
to read the current cache during a turn, filter exact accounts/windows, and
optionally request one bounded refresh. Keep uncertainty and account boundaries
explicit. The first implementation should include both modes if approved.

## Findings verified from source, not provider measurements

- `usage.rs::Usage` holds readings in a lock-free map. Normal readers reuse
  readings for 30 seconds, OpenRouter for 60 seconds. Peek and board freshness
  is 900 seconds. The board reads the cache without fetching.
- Claude uses an unexpired CLI OAuth token for an HTTPS usage request, never
  refreshes that token, times out at 15 seconds, and respects a 429 retry-after
  (default 60 seconds, clamped to 1 second through 6 hours). No inference request.
- Codex uses HTTPS `/wham/usage` first (15-second timeout). An inconclusive
  HTTP read can start an app-server fallback, at most once per login per
  30 minutes. Its lifecycle belongs to the existing graceful probe implementation.
  The module introduction still describes app-server as the primary reader.
- Google uses a CLI process, checks the CLI version, and requires `/usage`
  to report an empty conversation, zero turns and all zero token counters.
  Version and usage process timeouts are 20 and 30 seconds respectively.
  It uses one shared probe directory/log, so concurrent Google probes are unsafe.
- OpenRouter is currently one machine-wide lane. Its key standing combines
  key usage/cap and credits/balance. It has no fabricated reset deadline.
- Registered API-key accounts use local `ot.account_spend`; their quota is
  unsupported. The current spend reader conflates failed DB reads and missing
  rows, returning available=true and zero. A new query must not reuse that
  fabricated-success path for DB errors.
- Claude's cooldown branch can copy a last good reading and then call `put`,
  moving its cache age forward without a new provider observation. Query age
  must prefer a validated observation time and not re-date old bars.
- The board omits most unobserved lanes and API-key spend rows. It is therefore
  useful as a field reference, not a complete structured query implementation.
- `org_accounts` supplies the org allowlist. Registry `available_to` also
  enforces legacy origin and enabled status. Ambient records represent their
  provider's primary login. Queries must not create duplicate primary lanes.
- Tool group registration and live ancestor enforcement are shared in
  `domain/tool_groups.rs`, `tools/defs.rs`, and `tools/mod.rs`.
- Automatic cadence is 5 minutes below 80%, 2 minutes at 80%, 45 seconds at
  95%; Claude has a 2-minute idle cap. Open windows cap cadence at 60 seconds.
  Reset catch-up can recheck every 10 seconds up to four times. Registered
  accounts and OpenRouter are normally read every 60/300 seconds.

No live account files, provider endpoints, provider settings, or usage databases
were read during this audit. Request costs above are inferred from request type;
no new live provider cost measurement was performed.

## Approved contract

`orgtree_usage { accounts?, providers?, windows?, refresh?: false, limit?: 20,
cursor? }` returns JSON. Filters are exact strings, arrays of at most 32 values;
values within a dimension are OR, dimensions are AND. Empty explicit arrays and
unknown properties/types refuse rather than unexpectedly select everything.
Providers use canonical IDs `claude`, `openai`, `google`, `openrouter`,
`langserver`. Accounts use canonical lane/registry IDs, never email, folder,
token, key label or a provider nickname. Window selectors match canonical
`kind` or exact provider `group`; display labels are returned, not selectors.

Default reads are cache-only: no provider request, credential-file read, CLI
launch, account selection change, usage-history write or limit-mark change.
No-argument scope is all accounts the caller's org is allowed to use and whose
origin belongs to that org or is global, including inactive registered accounts
for read-only inspection with enabled=false. Never add a show-all escape hatch
or accept another org identity from tool arguments. Unknown/out-of-scope
explicit IDs use one generic refusal before any refresh. Revalidate scope after
awaits before returning a provider result. The caller's captured running account
may be identified as own; do not substitute its queued next-turn account.

Pagination is by stable account ID, default 20 accounts, maximum 100. Return a
next cursor when more accounts remain; window filters do not hide an account's
unavailable status. Cap each account at 64 windows with explicit window
truncation/count metadata. No unbounded history reads. A cache miss produces
an account row, never an omitted lane or a zero percent.

Each account carries ID, provider, enabled, own-account flag, source,
observed_at, age_seconds, freshness, availability/reason, and windows. Windows
carry kind, group, model/label when reported, used_percent, amount/unit,
resets_at and reset_in_seconds, and limited/marked/ok state. Separate freshness
from limit state. Null means not reported; stale numbers stay visibly dated and
are not asserted as current. Use explicit reasons no_cache, stale,
unsupported, failed, signed_out as appropriate, retaining the difference
between an unsupported quota and available local metering. Local servers
report no provider quota and their agent concurrency cap, not 0% usage.
No arbitrary cached JSON, raw error/detail strings, auth fields, provider
response bodies or config directories leave the handler. Allowlist the fields.

Refresh is optional and requires exactly one explicit account ID. Cached reads
need `inspection`; refresh additionally needs inherited `runtime`. Tool list
visibility follows inspection; runtime-disabled agents get an explicit refresh
refusal. No new group or top-level-only restriction. This gives existing scopes
the read tool while permitting supervisors to deny external work separately.

An accepted refresh attempts the existing account reader with its ordinary
cache/cooldown rules; there is no agent-controlled force. If the reading is
under 60 seconds old (Google: 300 seconds), return it without a new request.
Manual attempts, including failures, share an engine-wide per-account floor of
60 seconds (Google: 300 seconds), across orgs and agents. Preserve Claude's
longer provider retry-after and Codex's 30-minute fallback cooldown. A lock-free
per-lane reservation also covers background/HTTP readers so a manual refresh
cannot overlap a scheduled probe; an in-flight request returns cached data
with refresh_status=in_progress, not another queued provider operation.
Do not reduce existing automatic/reset cadence to impose the manual floor.

Refresh returns status attempted, reused, rate_limited, in_progress,
unsupported or failed, plus retry_after_seconds when known. Attempted is not
proof of a successful new reading. Keep old observation timestamps on fallback.
Existing provider timeouts bound synchronous work; one account per call avoids
an unrestricted batch of CLI probes. No new inference turns, auth refresh,
fallback account switches or account activation. Existing usage-history/mark
effects of a successful real probe remain documented and outside transactions.
API-key refresh is a bounded local spend read, with DB failure unavailable and
an absent row explicitly reported as no recorded spend. Local-server refresh
is unsupported because no provider usage reader exists.

## Integration boundaries and proof plan

- Centralize canonical lane/cache mapping in usage plumbing. Do not edit
  OpenRouter key storage or invent secondary OpenRouter IDs: obtain the upcoming
  owner's canonical account contract through lead-astra before wiring new keys.
- Add a safe observation projection independently of tool/refresh authorization;
  test cache miss, exact 900-second stale boundary, failed refresh preserving
  old observation, empty limits and unavailable versus unsupported.
- After ruling, add tool definition/implemented registry/dispatch, group checks,
  filtering/pagination, single-lane refresh gate and a rig proof with canned
  values/fake CLIs. Prove org isolation, live ancestor denial, strict filters,
  no cache-read probe/history effects, deduplication and retry metadata, and
  no synthetic credential in returned values/logs. Use scratch state only.
- Register the approved new behavior in PLAN section 10 and dated AGENTS/docs
  with its landing. Tool definitions change the prefix once for agents granted
  inspection; dynamic query results are new turn content, not startup text.
- Build outputs need an exact approved folder before check/test. The granted
  root is `C:\orgtree-build\usage-query-sol`; request use of its `cargo-target`
  and `tmp` children (the charter's generic cargo-target path is outside this
  agent's current C grant). Shared build lock/queue remain on D.

## Recorded rulings and current verification limits

User approval mf9c7f431147b (relayed by lead-astra m9a548e66fd50) selects saved
cache by default plus optional fresh single-account refresh with inherited
runtime permission, rate limiting, no inference and no account switching.
Lead-astra approves the remaining mechanics above. Inactive accounts may be
inspected but must refuse refresh. Exact C cargo-target/tmp children were
authorized by lead-astra m6c900416bc77; the shared D build lock is unchanged.

OpenRouter owner confirms its canonical contract (m0b3c97ec4248):
`openrouter::lane(id)`, inverse `id_of_lane`, `org_accounts::lane_of`, per-lane
cache keys, and `usage::openrouter_key_usage(engine,id,force)`. Original registry
`openrouter-key` maps lane `openrouter`; secondary `openrouter-N` rows map to
themselves. The original reader retains its signature. Both branches must be
composed with the shared reservation before a multi-key tool claim is verified.

Initial source checks: Rust parsing/formatting of new helper files and Node
syntax checking of the rig proof; git diff --check. Cargo check/test and changed
path rig execution have not yet run: queued behind earlier builders. The rig
proof uses canned usage/fake CLIs only. No live provider behavior is measured.
