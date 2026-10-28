# Engine and storage

[Repository startup guide](../../AGENTS.md) · [All topics and entries](README.md)

Actors, bounded reads, transactions, migrations, logging and data contracts.

The engine log formatter always drops `tokio_postgres::query` records, including
forwarded `log` events. Their debug output includes raw SQL bind parameters and
can expose account secrets; the default warn filter alone is insufficient when
an operator overrides `ORGTREE_LOG`. See the [standalone account boundary](../rust-engine/STANDALONE-ENGINE.md#user-account-mcp-additions-2026-10-24).
[verified: `trace.rs`, synthetic user-MCP database canary; 2026-10-24]

Dead-letter feed/list totals use transactionally maintained per-recipient
open/dropped counts; partial recipient/id indexes serve the matching page
predicates. Completed/dropped mail history is retained without slowing default
refreshes. Migration0051 backfills once. See [reader contract and SQL proof](../rust-engine/dead-letter-readers.md).
[verified: `migrations/0051_dead_letter_readers.sql`, `domain/dead_letters.rs`, `feed/compute.rs`; 2026-10-21]

These attributed records were moved from the root guide at `22daffd`; they retain the original substance, dates, verification limits and replacements. They are source evidence, not a declaration that every historical state is current. Read the signed decisions/current source before changing behavior. Inline source paths remain relative to the repository root; Markdown links were rebased. Add current detailed guidance here; preserve replaced records in history and update the coverage destination when moving one.

<a id="e-de18dabbab8e1f0f"></a>

## What it is

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3704–3704.

<!-- preserved:e-de18dabbab8e1f0f -->
**What it is**
<!-- /preserved:e-de18dabbab8e1f0f -->

<a id="e-8dce3c42844fb6c8"></a>

## Storage: one database orgtree_engine, schema ot, in the bundled PostgreSQL cluster;

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3711–3714.

<!-- preserved:e-8dce3c42844fb6c8 -->
- Storage: one database `orgtree_engine`, schema `ot`, in the bundled PostgreSQL cluster;
  migrations are embedded in the binary (`engine/rs/orgtree-engine/migrations/`). At first start
  it imports the 3.2 per-org databases **read-only**; the old databases and files are never
  changed. [verified: `src/pg.rs`; PLAN §3, §8]
<!-- /preserved:e-8dce3c42844fb6c8 -->

A numbered migration never changes: the engine records each applied migration's checksum and
refuses to start when its text changed (`src/migrate.rs`, "checksum drift"). 0063 was edited after
it was numbered and stays as shipped (4.5.0 high D13). `tests/migration-checksums.test.mjs` pins
every registered migration in `migrations/pinned-checksums.txt`: a new migration adds its line, and
a fix goes forward in a new migration. `MIGRATIONS` applies in array order, so a fix may sit
around a shipped migration under a name that sorts between its neighbours (`0070_keep_panel_messages`
and `0071a_restore_panel_messages` around 0071, D14); the staged migration tests cut the list at
`name < "00NN"`, which relies on that order. [verified: `src/migrate.rs`; 2026-10-28]

<a id="e-aad7fd24eb2bb4c0"></a>

## Engine log: one file per start, &lt;data&gt;\diagnostics\logs\&lt;start time&gt;.log, kept 30 days.

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3731–3736.

<!-- preserved:e-aad7fd24eb2bb4c0 -->
- Engine log: one file per start, `<data>\diagnostics\logs\<start time>.log`, kept 30 days.
  Every line prefixes the emitting Tokio task as `T<id>`, or `T-` outside a task;
  this is read at emission, independent of inherited request/client/frame spans.
  [verified-from-source: 2026-10-07, `src/trace.rs`, Tokio 1.53.2 `task::try_id`;
  recorded-decision: user 2026-10-07 07:46Z, DECISIONS 34]
  [verified: `src/trace.rs`; decided: user, DECISIONS 34–36]
<!-- /preserved:e-aad7fd24eb2bb4c0 -->

<a id="e-8a2c86f559551e4f"></a>

## Engine code rules

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3957–3958.

<!-- preserved:e-8a2c86f559551e4f -->
**Engine code rules** [decided: user, DECISIONS 5, 34–36; verified: `engine/rs/orgtree-logged/src/lib.rs`,
`src/trace.rs`]
<!-- /preserved:e-8a2c86f559551e4f -->

<a id="e-8192a6f3da6dff13"></a>

## #[logged] on every engine method. Put #[logged] on each free function and inherent

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3979–3984.

<!-- preserved:e-8192a6f3da6dff13 -->
- **`#[logged]` on every engine method.** Put `#[logged]` on each free function and inherent
  `impl` block; it logs every call with its arguments and its return value under one invocation id.
  Do not put it on an individual associated function inside an impl: that expands as a free
  function and fails to resolve its generated helper. [verified 2026-10-07: macro source, cargo check]
  Mark only extremely hot methods (per-token streaming, per-record feed rebuilding, tiny helpers)
  `#[nolog]`. Verbose logging is off by default in packaged builds and on in development builds.
<!-- /preserved:e-8192a6f3da6dff13 -->

Verbose logs may contain sensitive data by design (app content, private paths, transcripts); it helps debugging, so it is not a defect (user 2026-10-28 m7ad336de1604). Normal (non-verbose) logs should not carry it, and secrets stay `#[nolog]`.
So the wire logger's REQUEST/RESPONSE lines show a request's route and its query parameter names with `****` values
in the normal log, and the whole query when verbose; `/api/markdown-image` and private Apps routes show the bare path in
both (`request_target_for_log`, `query_names_only` in `http/mod.rs`). The wire-privacy rig proofs match routes in the form
the mode logs.

Secret-bearing arguments must use `#[nolog]` or an opaque formatter, as for
`runtime::AgentMsg`. `AgentMsg`'s exhaustive Debug
formatter emits its static variant only: actor handler/send logging must never
serialize the nested provider/tool body before JSON redaction. A Debug formatter
is opaque only for a type without `Serialize`: the trace renders serializable
values as JSON first (`trace::show` L2 before L1), so logged
`runtime::prompt::Mail` arguments show their bodies (measured 2026-10-26). Direct JSON
arguments continue through `trace::Shown::json`; useful call/return diagnostics
remain enabled. See [WebSocket log verification](../rust-engine/websocket-watchdogs.md#tests).
[verified: `runtime/mod.rs`, `runtime/actor.rs`, `trace.rs`; 2026-10-22]

App file and import/export workers use `trace::private_app_blocking`: task-local
privacy on an async caller does not automatically reach blocking threads.
Establish the private scope inside the worker so nested logged path helpers and
manual events stay opaque, while ordinary worker diagnostics remain enabled.
See [App logging](../rust-engine/custom-apps.md).
[verified: `trace.rs`, `domain/apps/{file_access,file_scopes}.rs`, `tools/apps.rs`; 2026-10-26]

App content read back outside the private request (an app's mail, its docket
assignment notice, its named event's delivery) is omitted by value in the log
renderer: `trace::private_app_content` recognizes the stored row or `Mail` by its
provenance, so every logged function that receives it stays covered without its
own `#[nolog]`. Ordinary mail renders unchanged. See [App logging](../rust-engine/custom-apps.md).
[verified: `trace.rs`, `runtime/actor.rs::mail_of`; 2026-10-26]

<a id="e-50cc1d4e5597f3d3"></a>

## App registry locks and restore boundary: app migration 0005_app_feed.sql

Original section: Architecture. Source lines 4313–4320.

<!-- preserved:e-50cc1d4e5597f3d3 -->
- **App registry locks and restore boundary:** app migration `0005_app_feed.sql`
  owns the deferred registry revision update; lifecycle writers never acquire that
  singleton themselves. Existing restore tools handle legacy or individual org
  databases; a future app-database restore must change its incarnation with the
  engine stopped and the root owner lock held. See the
  [writer and restore inventory](../../docs/state-system/app-feed-writer-audit.md).
  [verified: `orgdb/lifecycle.py`, `orgdb/names.py`, `pg-custodian/src/backup.rs`;
  decided: step-6 addendum section 5; 2026-10-05]
<!-- /preserved:e-50cc1d4e5597f3d3 -->

## Hire preferences (2026-10-24)

`domain/ops.rs` carries `model_version`, `session`, `peer_mail` and `auto_cheap_compact` into the same scope inserted for a new hire, including superior insertion. These node-local preferences do not override its four inherited permission fields. Validate before insertion/warm: session kinds through `session_host`, cold-turn fields through `settings::cheap_compact`, model pins and selected-login Muse admission, and effort/speed against the pin. Hire/staff creation contracts expose these optional fields; restoration refuses creation-only overrides and retains saved preferences.
