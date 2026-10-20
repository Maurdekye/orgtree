# Engine and storage

[Repository startup guide](../../AGENTS.md) · [All topics and entries](README.md)

Actors, bounded reads, transactions, migrations, logging and data contracts.

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
