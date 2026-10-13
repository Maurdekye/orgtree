# On-demand usage query: audit and proposed contract

Contract approved through lead-astra, 2026-10-11 22:35Z. The standalone source
and checked-auth composition are integrated; dated verification below separates
those receipts from the later OpenRouter composition.
Ticket: `agents-can-query-usage-statistics-on-demand`.
Source audit base: local `rust-engine` at `89268b7`.

Agents receive a usage snapshot only at a turn boundary. Add `orgtree_usage`
to read the current cache during a turn, filter exact accounts/windows, and
optionally request one bounded refresh. Keep uncertainty and account boundaries
explicit. Both modes are implemented under the approved access and refresh contract.

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
`langserver`; the separately integrated Muse lane also accepts `muse`.
Accounts use canonical lane/registry IDs, never email, folder,
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

## Measured standalone verification (2026-10-11)

- First cargo check --locked -j2 -p orgtree-engine --bin orgtree-engine passed
  in 5m01s at source8ffda24, using the approved C target.
- Focused cargo test --locked -j2 -p orgtree-engine --bin orgtree-engine usage::
  passed 11 tests, zero failed, 83 filtered, in 3m49s at committed7259d30.
- Rebased onto rust-engine4fa41d4; engine/source6da8b55 composes existing
  settings.provider_enabled with each account/server flag, matching the
  canonical global-active contract. Org allowlists separately filter visibility.
- Locked -j2 standalone builds atb5ae453 passed: engine1m35s, fake CLI12.47s.
  No installer or app build. Free RAM started5.6GiB and briefly fell to2.48GiB
  during engine compilation; it completed before the scoped stop check, no
  process was killed. Free RAM recovered5.5GiB; owned build artifacts2.708GiB.
- Engine SHA256 A6515455D69E095CC71111D7D7C021E9B661DB60045F2DE3BA41B5C1D8801F89;
  fake CLI SHA256 A1696BFD0E8E8D386B831EB57861F97EAF978182CDE7893CFA5939D296357269.
- Scratch changed-path proof at01c4ae7 passed all29 checks against that binary.
  It verifies cached reads do not probe/write history; dated stale windows;
  safe response fields; exact filters/pages; inherited live permission denial;
  org/origin scope; one concurrent fresh read, manual floor and no inference
  turn; absent/error local metering versus zero; globally inactive providers,
  registered accounts and individual servers remain inspectable/refuse refresh;
  unsupported local-server quota and org server exclusion. The first rig pass
  found proof defects (read-only SQL helper and unsettled boot polling); these
  were fixed in proof-only01c4ae7 before the passing run. No engine rebuild was
  needed. No live provider behavior is measured.
- Supported rig finally stopped every process. Independent process inspection
  found no owned rig processes remaining. Source diff/Node syntax checks pass.

Logs under D:\orgtree-work\evidence\usage-query-sol:
cargo-check-20261011.log, cargo-test-20261011.log,
cargo-build-engine-20261011.log, cargo-build-fakecli-20261011.log,
rig-usage-query-20261012-pass2.log. Structured29-check evidence:
D:\orgtree-work\rig\usage-query-sol\evidence\usage-query-20261011T235847\result.json.

## Historical standalone dependency and limits

Lead-astra mf99e653ce9f3 directs the multi-OpenRouter owner to remain paused on
its original provider until its weekly capacity resets; no transfer of unfinished
implementation/rig/integration work to this seat. The standalone tool source
uses only the current integrated original lane. After the original owner finishes
and lead sends checked integration notice, compose its private per-key reader
with the shared reservation and verify this tool's lane-specific behavior.
Do not claim multi-key support from this standalone proof. The hold above was
released by the coordinator's checked integration notice on 2026-10-13; see the
OpenRouter composition section below. It is not a current unfinished dependency.

The original standalone proof checks response secrecy. Independent review found
raw provider logging; the correction and focused response/log evidence below
supersede that earlier verification limit. Real provider timeout/auth behavior
and UI/app packaging were not exercised. Checked-auth composition is implemented
and verified below, then approved and integrated at `9a2fdd9`. Later multi-key
composition has its own source and proof evidence; the earlier standalone run
does not establish it.

## Checked authentication composition (2026-10-12)

Lead checked integration notice mb6bef247b3bd authorizes consumption of
continuation f8b49ac after independent round3. Approved standalone765a617
rebased onto that source, then onto ordering41f1c0 per lead's later notice.
The first rebase required three conflict-block reconciliations in usage.rs:
retain the auth map alongside probe/manual maps; retain checked Claude result
processing in place of the older inline fallback; retain single/aggregate auth
helpers alongside the reviewed unlogged peek. Production and canned Claude
both still call claude_result; cooldown returns without cache insertion. The
checked record_auth, claude_result, claude_cooldown and auth helper bodies are
unchanged. Ordering documentation and schema changes are preserved. Old
approved source765a617 remains reachable as usage-query-sol-before-auth-20261012.

The tool consumes cached_reauth_required_across over exactly the checked
physical-login aliases: canonical native key plus same-provider native registry
keys; an independent imported login uses its own key. Only the resulting boolean
is consumed, never hidden row metadata or paths. API-key metering, local servers
and OpenRouter are outside this native-auth overlay. Latest genuine fresh auth
observation wins; transient/error/cooldown supplies no newer observation.

Known negative authentication changes availability to false and cause to
signed_out, retaining quota windows, observation time, age and freshness. A
newer genuine success clears that overlay. If the selected quota cache itself
is an older failed sign-in reading, newer positive auth clears its outdated
sign-in cause to failed; it cannot invent a successful quota measurement or bars.
The refresh result rejects explicit negative flags even with available=true and
error=null. Final aggregate auth also converts attempted/reused to failed when
negative; busy and rate-limit states remain intact, and cache reuse/attempt
cadence is unchanged. Final classification uses the same auth observation as
the returned row, after all permission/scope awaits.

The focused usage-query-auth.mjs proof exercises both native/explicit directions,
negative after success, transient after negative, independent imported login,
contradictory quota availability with negative auth, actual tool log secrecy,
no inference, failure floor and recent-cache reuse. Measured pre-composition
baseline2bee261 built in1m02s; the real tool proof failed9 of14 checks.
Composition f18e96b plus parser/projection tests67930a7 built in54.90s.
Focused tests passed19/19, zero failed,83 filtered,49.60s at67930a7.
The composed proof at67930a7 passed14/14, and the existing tool-interval secrecy
proof passed24/24 again against the composed binary. All six secrecy intervals
retain zero synthetic marker lines and verbose safe diagnostics. The baseline
auth proof has14 checks, correcting an earlier status message that counted15.
Engine SHA256:
2919AFD79DA20FD1E2DFE3D160EB5AC8713510C0A9F720C68B8300EB2326B922.
Receipt logs under D:\orgtree-work\evidence\usage-query-sol:
cargo-build-auth-baseline-20261012.log, cargo-build-auth-composed-20261012.log,
cargo-test-auth-composed-20261012.log, rig-auth-red-20261012.log,
rig-auth-green-20261012.log, rig-secrecy-auth-composed-20261012.log.
Structured red/green auth receipts under the owned rig evidence folder:
usage-query-auth-20261012T005220/result.json (9 failures of14),
usage-query-auth-20261012T005725/result.json (14/14), and
usage-query-secrecy-20261012T005751/result.json (24/24).
auth-helper-provenance-20261012.json confirms unchanged checked helper bodies.
No fake-CLI rebuild, live provider call, app build or OR composition occurred.

## Raw provider logging correction (2026-10-12)

Independent review reproduced nine synthetic marker lines in the tool-only
refresh interval while the response stayed clean. Raw-return readers and parsers,
cache peek, profile mark/history processing, usage-history helpers and raw fake
readers now use `#[nolog]`. This includes WHAM JSON and Codex app-server result
processing. Usage history emits only account/provider, availability, window
count and SQLSTATE on failure; rejected upstream values and database error
messages are excluded. Safe refresh diagnostics remain verbose.

The focused `usage-query-secrecy.mjs` proof captures every engine log line from
immediately before the accepted tool request until after completion/flush;
setup HTTP reads are outside the interval. It uses synthetic unknown fields,
error/body details and fake tokens. Six operations cover canned success and
failure, real WHAM loopback success and HTTP500/fake-app-server fallback,
and production Google structured JSON/log parsing success and failure.
Google parsing is extracted unchanged into an unlogged helper; a rig-only
input hook reaches it without a live CLI/provider call. Zero-turn/token checks
remain intact. A process restart in the disposable rig resets the Google
manual floor before its failure case.

Measured before correction: marker-line counts 9,13,1,0,7,7 respectively.
The old binary also cannot satisfy the newly added Google structured-parser
positive control because it predates that rig-only hook. Corrected engine
bc8af74 built under the shared lock in56.81s, exit0. Binary SHA256:
2B5B4E6AAE666BA49900BDD02AE0554D296E8631EDB655F5BF57020AD09DC950.
Focused proof at8d2c5b0 passed24/24, zero marker lines in each interval.
The final proof atbad62ca strengthens the WHAM failure control to assert the
fake fallback's10% bar and also passed24/24, with zero marker lines and safe
verbose diagnostics in every interval. Focused cargo tests atbad62ca passed
13/13, zero failed,83 filtered,36.59s, exit0. They include zero-turn/token and
missing-token-evidence refusal plus structured Google/log extraction controls.
The binary remains bc8af74: later Rust changes add only cfg(test) code; all
production code exercised by the final proof matches that build. Original
11/29 standalone proofs remain valid for their measured axes; no unrelated
checks/artifacts were repeated. No owned processes remain; supported rig
cleanup reports runs=[] and strays=[]. Owned C artifacts total3.999GiB.
Logs: D:\orgtree-work\evidence\usage-query-sol\cargo-build-secrecy-20261012.log,
rig-secrecy-red-20261012-pass2.log, rig-secrecy-green-20261012.log,
rig-secrecy-final-20261012.log, cargo-test-secrecy-20261012.log.
Structured results: D:\orgtree-work\rig\usage-query-sol\evidence\
usage-query-secrecy-20261012T001837\result.json (red), and
usage-query-secrecy-20261012T001904\result.json (first green), and
usage-query-secrecy-20261012T002217\result.json (final green).

## Checked OpenRouter composition (2026-10-13)

Coordinator mb7fbc4456f25 supplies the awaited integration notice: OpenRouter
`d3de2dd`, Muse `c8a4b02`, then Providers `417083c`. The OpenRouter final review
was user-waived; this is checked coordinator integration, not a claimed new
independent OpenRouter security pass. The remaining original usage-query
composition is now complete; no takeover of paused owner work was needed.

The original owner already supplied the agreed source plumbing. The original
query ID/cache/history/reservation lane is `openrouter`, with storage ID
`openrouter-key`; added keys use their registry IDs as distinct lanes. The
original registry row replaces the synthetic entry and supplies its real active
flag. Org allowlist and registry origin still constrain cached visibility;
global/account active flags additionally constrain refresh. Storage IDs are not
accepted as extra aliases for the original query lane.

`openrouter_key_usage` reserves its canonical lane and calls the private
`openrouter_key_read`. Legacy `openrouter` and registered/HTTP/scheduled readers
use that public wrapper. `refresh_permitted` receives the tool's held permit
and dispatches directly to the private reader via `id_of_lane`, with OpenRouter
excluded from generic API-key local-spend dispatch. This avoids reacquiring its
own permit, preserves independent per-key floors/cache/history and retains the
original reader's ordinary cache/cooldown rules. Inspection, runtime, inactive
and post-await scope checks remain in the existing tool handler.

Existing owner proofs were reused for per-key HTTP readings/history and
replacement/secrecy behavior: current composed Muse receipts
`openrouter-keys-20261013T092055`29/29 and
`openrouter-keys-corrections-20261013T092151`50/50. They are earlier inspected
measurements, not rerun claims. The auth helpers `record_auth`, `claude_result`,
`claude_cooldown`, `cached_reauth_required` and its aggregate compare unchanged
against approved `9a2fdd9`; `usage/query.rs` has the identical Git blob
`a66e9edb2b42a4701b14901f9b2ebd82c64b1559`.

New focused proof `tools/rig/proofs/usage-query-openrouter.mjs` uses the real
tool route, two dummy stored keys, canned metadata and fake CLIs only. It proves
distinct dated21%/73% rows; cache-only no-read/no-history; original-ID uniqueness;
original active-switch and org exclusion enforcement; same-key manual/public
contention returning dated data; other-key admission while that permit is held;
private-reader completion; independent manual floors; no inference/account
switch; and response/log secrecy. A61-second deadline wait expires the ordinary
reader insertion cache; no force flag or cache bypass is added to the agent tool.
The first key deliberately retains a stale provider observation even after an
attempt, demonstrating that attempted is not a claim of fresh data.

The focused red run at `7d559cd` passes13/14 and exposes one private marker line
from the rig-only `rig::openrouter_key` raw return. Commit `bbffbc4` makes that
canned-document hook `#[nolog]`; it returns None outside rig mode and changes
neither production reader behavior nor authentication controls. Earlier fixture
failures (using the original endpoint to seed the added cache, and requiring a
public-wrapper diagnostic in a private-reader interval) are retained and are not
production-defect evidence.

Final proof at clean `3535af8` passes14/14, exit0 in70.111s, with zero marker lines
and safe `refresh_permitted` diagnostics. Evidence:
`D:\orgtree-work\rig\usage-query-sol\evidence\usage-query-openrouter-20261013T134554\result.json`,
SHA256 `4d23061db99fa853a81dd232e246fe1ecf78d7c3d34c395fc11f16335b3a1a30`;
the sibling `tool-interval.log` has SHA256
`ee91d87a603a05ed67d2f9170ee9948b90ee88bfe845c229811345d0e6924d4a`.

Builds used the granted C target/tmp, separate machine lock acquisitions,
cargo-j2 and kernel Job containment. Current integrated engine built at
`1ed7e32` in93.743s; the corrected engine at `bbffbc4` built in28.328s, both exit0.
Fake CLI at `ca1c79f` built in5.682s, exit0. Corrected engine SHA256
`9a7f6b67966fe3c0beb710b947f6b711f305e87a122260578a1aa1f14d3dcea3`;
fake CLI SHA256
`94c9163b5bc97b8b9fc4eb9340d367532111b3542e3006ba2f4b91fd224bf150`.
Final proof engine sources match the corrected build exactly; fake sources match
their build exactly. Logs are `compose-{engine,fake,proof}-*.log` under
`D:\orgtree-work\evidence\usage-query-sol`; auth correspondence is recorded in
`auth-helper-provenance-20261013.json`.

Supported cleanup reports runs=[]/strays=[]; no owned jobs or queue remain.
Prior standalone29/auth14/secrecy24 and focused19-test measurements retain
their source-specific limits. No new live/provider/paid call, broad suite,
installed UI/app package, release or stopped-review retry was performed.
