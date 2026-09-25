# P03 WS2 — M1 interface contract (executor API, base schema slice, Sent stub)

**Implementation notes after the freeze (no frozen name changed; lead notified 08:23Z / 08:4xZ):**
- `Tx::exec(label, sql: &'static str, params)`: statement text must be a constant, so no argument-derived literal can reach SQL text or traces (lead condition on `Statement.sql`); a compile_fail doctest proves it.
- Sent stub: `record_sent(tx, &SendRequest) -> Result<SentRecord, SendError>` with `SendError = Refused(Refusal) | Db(DbError)`, org taken from `tx.op().org`; `lock_grantee_for_grant(tx, org, grantee) -> Result<(), CmdError>`.
- Unsafe controls: `controls::fire(&tx.scope(), "<schedule>.<variant>")`.
- `Executor::new(main, main_size, reserved, reserved_size, cfg, hooks)`: the reserved pool serves lookups and in-flight rows (§4).
- Trace additions for WS7: `Statement.sql`, `ConnOpened.{backend_start, host, port, role, database}`, `Commit.pre_commit_lsn` (lower bound), `XactStats { tables }`.
- The door hook is **two** lines in `api.py` (an import and the `install(app, store.DATA_ROOT)` call, matching the neighbouring `startup` pattern), not one.
- Migration `0008_grants.sql` (WS2 range) grants the WS1 roles; `min_writer` is the optional first-line header `-- orgtree:min_writer=N` shared with WS1's run-time runner.

**Freeze amendment 1 (lead decision 2, 2026-09-25):** `charter_heads` and `charter_versions` carry `charter_kind` (`'role'` | `'team'`) in their primary keys (each node has a role charter AND a team charter; Q-CR r2). `runtime_state` loses `status`/`status_note`: status lives only in WS4's narrow per-seat status row (0200, S3 §4.1).

**Freeze amendment 2 (lead decision 3, 2026-09-25) — §3.2 order.** Step 3 (the anchor) still TAKES its locks first (C4 step 1), but a refusal (`CmdError::Refused` from `anchor`) is only RECORDED. Step 4 (the claim) then decides: a committed receipt goes to the replay path (`may_disclose` → `Replayed`/`NotDisclosed`; `Conflict`/`Fenced` as before) whatever the verdict; only with no committed receipt does a recorded refusal answer `Refused`, with ROLLBACK (the claim disappears, E-D5). A lost-COMMIT resolution never returns a pre-claim outcome: it re-claims the key FIRST (before any anchor), replays a committed receipt, or answers `Unknown` if the wait times out. Unsafe control `Q-C4.anchor_refuses_first` restores the old order. Consumers keep the same `anchor()` signature: returning `Err(CmdError::Refused(..))` is still how an anchor refuses.
*Legacy parity (disclosed departure, required by r7 C1 and v6 I05):* legacy `agent_call` authenticates the seat (`_agent_identity`, `api.py:11213-11271`: archived / replaced / stale-generation → 403) and checks halt/killswitch (`api.py:11290-11295` → 409) BEFORE the receipt admission under `DOC_LOCK` (`_op_inflight` + `opreceipts.admit`, `api.py:11831`). So legacy REFUSES a keyed retry from a halted or archived caller even when the original applied; native replays it (subject to `may_disclose`). The authentication of the principal itself (the door's 403) is unchanged: that happens before the executor.

**Further additive changes after the freeze (no frozen name changed):** `Executor::read` (read.rs); `CmdError::RetryAttempt { cause }` and `CmdError::Refused(Refusal)`; `Command::causal_refs()` (default empty) and `EventKind::{CausalRefs, Mark, XactStats, XactLocks}`; `ExecConfig.{lock,statement,idle_in_transaction}_timeout_ms` with provisional non-None defaults (5 s / 30 s / 60 s; WS8 proposes the real values); `runtime_inflight.call_id` (one in-flight row per call; `admit_inflight` returns the call id); restriction acks lock the restriction row first; the store service's host bracket (`--root`, custodian files, identity = instance_token + root_id + system_identifier, one stdout ready line, `service.shutdown`, `--exit-on-stdin-eof`); WS7 harness holds may name an `attempt`; per-range store-schema layout (`ranges/<ws>.range` + `.sha256`).

**FROZEN at r3 = `7a19d55`** (lead decision 1 on `p03-ws2-store-core-schema-slice-command-executor`, 2026-09-25 08:08Z). **r4** adds, with the lead's ack and no frozen name changed, the DECLARED-CONTACTS table and the WS7 protocol reference to §5.

**r3** applies the lead's review of the r2 migrations: F1 inverts the `restriction_epoch` lock modes (§6), F2 removes the foreign keys from high-rate tables to `organizations` and F3 removes `mail_sent`'s foreign key to the destination head (§7 "Foreign-key rules"), N1 declares server-side statements (§7). Nothing else changed.

**Status:** r2, for the lead's "agreed" (the M1 freeze is that decision on docket item `p03-ws2-store-core-schema-slice-command-executor`). r2 applies the lead's rulings `M1-INTERFACE-CONTRACT.md` (artifact r2 on `p03-plan-private-service-and-narrow-prototype-on`, sha256 `7ac83028…fbcb`): all six r1 questions agreed; §3.1/§3.2 small API tidy; §3.7 group identity; §3.8 connection factory; §5 replaced by the merged harness contract; §6 names the Q-C6 variant; §7 lists publication; §9 adds the live-root refusal and `op_tag`. After the freeze, changing a frozen name or shape needs the lead's ack and a mail to every consumer.
**Author:** p03-ws2-storecore, 2026-09-25. Base commit `aa8dec1` (fetched `origin/v3/3.0.0-alpha.0`).
**Sources:** r7 = `NATIVE-CONFLICT-PREDICATE-ISOLATION-DESIGN-r3.md`; S3 = `NATIVE-CONFLICT-EXTENSION-S3-r3.md`; v6 = `architecture-review-v6/*`. Items marked **(choice)** are mine, not dictated by a design; they are the ones to push back on.

Consumers: WS3 (island families), WS4 (READ COMMITTED families), WS5 (mail), WS6 (feed, needs table list), WS7 (pause points, trace hook), WS1 (migration list, roles, incarnation row).

---

## 1. Crates and build

| Crate | Path | Contents |
|---|---|---|
| `orgtree-store-schema` | `engine/native/store-schema` | SQL migrations as files, embedded with `include_str!`; `MIGRATIONS: &[Migration]`; static lints. No driver. |
| `orgtree-store` | `engine/native/store` | executor, pool, receipts, in-flight rows, output-claim registry, pause/trace hooks, Sent stub, family modules (WS3-WS5 add modules here or in sibling crates that depend on it). |
| `orgtree-store-service` | `engine/native/store-service` | binary: channel listener, request routing to families. |

- Standalone crates with path dependencies, like the existing five; **no Cargo workspace** (agreed). `CARGO_TARGET_DIR=<worktree>\artifacts\cargo-target` (repo `.gitignore` ignores `artifacts/`, not `target/`), shared by every P03 crate in that worktree. `CARGO_BUILD_JOBS=4`. Each crate has its own `Cargo.lock`, and every P03 crate locks the **same** version of each shared dependency (tokio, tokio-postgres, serde, serde_json, uuid); the reviewer checks this against DEPENDENCIES.md.
- Driver: `tokio-postgres` (choice), behind the `Session` trait (§3.1) so every executor rule is unit-testable with a fake session that injects SQLSTATEs. Pool: our own (a FIFO `tokio::sync::Semaphore` is fair), no pool crate. Every new crate goes in `engine/native/store/DEPENDENCIES.md`.
- Reused decide crates: `op-receipt-codec` (key grammar `parse_key`, `legacy-1` fingerprint), `backend-codec` (exact 0.01 credits `Credits(i64)`, identity codecs), `funding-core`, `scope-clamp`, `work-name-codec`. Their inputs are legacy JSON shapes; families adapt rows to them.

## 2. Identity and type conventions (every table)

- Immutable ids are `uuid`. Every org-scoped table has `org_id` first in its primary key, and every org-scoped foreign key includes `org_id` (v6 SCHEMA-CATALOG:5).
- Every textual key compared for identity (names, resource, integration key, op key) is `text COLLATE "C"` (r7 §3.2 byte-exact rule).
- Credits are `bigint` hundredths (`backend-codec::Credits`), never float or `numeric` arithmetic in SQL.
- Constraint names are stable API: the retry allowlist (§3.4) and traces refer to them.
- Narrow version rows (r7 C3) never share a row with busy/status/heartbeat fields. Rows only ever updated in place (no FK-referenced column changes) are locked `FOR NO KEY UPDATE`, not `FOR UPDATE` (S3 §8, M1). `FOR UPDATE` only where a key column changes.

## 3. Executor API (`orgtree_store::exec`)

### 3.1 Shapes (Rust, abbreviated)

```rust
pub enum Isolation { ReadCommitted, Serializable, RepeatableReadReadOnly }

pub struct Family {                     // one static per family, registered at startup
    pub name: &'static str,             // "reservation", "staffing", "mail.source", ...
    pub isolation: Isolation,           // r7 C2a: island = Serializable
    pub retry_unique: &'static [&'static str], // 23505 constraints this family may retry on,
                                        // added to the global allowlist (§3.4)
}

pub enum KeyNamespace {                 // S3 E7
    Agent { principal: Uuid },          // agent keys under the IMMUTABLE principal
    QuickStaff { item: Uuid },          // (item, request_id)
    Operator { operator: Uuid },        // (org, operator, key)
    Minted,                             // door without a caller key (E4): adapter mints a uuid key
}

pub struct OpIdentity { pub org: Uuid, pub ns: KeyNamespace, pub key: String,
                        pub fingerprint: String, pub fingerprint_codec: &'static str,
                        pub caller_keyed: bool }

pub struct Binding {                    // bound by the authenticated adapter (door), never by caller JSON
    pub principal: Principal,           // Agent{id,generation} | Operator | KioskVisitor{..} | System
    pub acting: Option<Uuid>,           // S3 E5 acting identity
    pub op: OpIdentity,
    pub db_incarnation: Uuid,
    pub op_tag: Option<String>,         // harness tag (§5); None outside qualification builds
}

pub trait Command {
    type Output: Serialize + DeserializeOwned;
    fn family(&self) -> &'static Family;
    fn verb(&self) -> &'static str;
    /// C4 step 1: caller/acting anchor. Runs BEFORE the receipt claim (S3 E1.1 order).
    async fn anchor(&self, tx: &mut Tx<'_>, b: &Binding) -> Result<(), CmdError>;
    /// May the (current) caller see a replayed projection? (v6 I05: replay still checks disclosure)
    async fn may_disclose(&self, tx: &mut Tx<'_>, b: &Binding, stored: &Self::Output) -> Result<bool, CmdError>;
    /// Read set -> decide -> apply (C6). Returns Applied (commit) or Refused (rollback, nothing written, E-D5).
    async fn execute(&self, tx: &mut Tx<'_>, b: &Binding) -> Result<Decided<Self::Output>, CmdError>;
}

pub enum Decided<T> { Applied(T), Refused(Refusal) }   // post-commit effects are registered on the Tx

pub enum Outcome<T> {
    Applied(T),                         // committed now
    Replayed(T),                        // same key + same fingerprint, already applied
    Conflict,                           // same key, different fingerprint
    Fenced,                             // key fenced by a receipt lookup: refused, nothing done
    Refused(Refusal),                   // domain refusal, nothing committed
    RetryExhausted { attempts: u32, last_sqlstate: String }, // truthful retryable refusal (C1)
    Unknown,                            // commit ambiguity not resolved within the lock timeout
    NotDisclosed,                       // replay exists but caller may no longer see it
}
```

`Tx` exposes only: `exec(label, sql, params)` (every statement is labelled; the label is the trace and pause identity), `now()` (§3.5), `pause(name)` (§5), `after_commit(effect)` (register a post-commit effect: a hint, never a durable write — durable intents are rows written in the transaction). No raw connection escapes, so there is no hidden statement.

`Executor::run(cmd, binding) -> Result<Outcome<T>, ExecError>` is the only entry for mutations (`ExecError` = a defect: a non-allowlisted `23505`, any other SQL error, an undecodable stored result). `Executor::read(snapshot_fn)` runs a `REPEATABLE READ READ ONLY` snapshot with no receipt (r7 C5 / S3 E2).

### 3.2 One attempt, in order

1. Pool admission (bounded, FIFO fair). Separate small reserved capacity for recovery/lookup (v6 Scheduling).
2. `BEGIN ISOLATION LEVEL <family>`; set `lock_timeout`, `statement_timeout`, `idle_in_transaction_session_timeout` (values from WS8 measurement; config, not constants).
3. `cmd.anchor()` — caller anchor (C4 step 1).
4. **Receipt claim** (E7): `INSERT INTO operation_receipts (... state='claimed' ...) ON CONFLICT ON CONSTRAINT operation_receipts_original_key DO NOTHING RETURNING`. Inserted → continue. Not inserted (committed row exists; an uncommitted one makes the INSERT wait) → classify: `applied` + same fingerprint → `may_disclose` → `Replayed`/`NotDisclosed`; different fingerprint → `Conflict`; `fenced` → `Fenced`; `compensated` → `Replayed` with its compensated projection. Then `ROLLBACK`.
5. `cmd.execute()`. `Refused` → `ROLLBACK` (claim disappears; E-D5).
6. `Applied` → `UPDATE operation_receipts SET state='applied', result=…, decided_at=now()`; insert causal intents (§6); `COMMIT`.
7. After commit only: run registered effects (hints, MPSC wake). A failed attempt never runs effects (v6 I04).

A deferred constraint trigger refuses COMMIT while any row this transaction wrote is still `claimed` (so "claimed" is never observable — E7), and is itself mutation-tested.

### 3.3 Operation identity across attempts (C1, Q-C4)

The `OpIdentity` is fixed for the whole `run`: every retry and the unknown-commit resolution reuse it. Keyless doors get a **minted** uuid key once per request, and it is still a receipt key, so unknown-commit resolution works for them too.

### 3.4 Retry classification (C1)

| Error | Action |
|---|---|
| `40001`, `40P01` | retry whole attempt, same identity, fresh timestamp |
| `23505` on a constraint in `GLOBAL_RETRY_UNIQUE ∪ family.retry_unique` | retry |
| `23505` on any other constraint | fail at once as a defect (`Outcome` error, logged), never loop |
| `55P03` lock_not_available (lock timeout) | family decides; receipt lookup maps it to `running` (§4) |
| connection loss / IO error **during COMMIT** | unknown → §3.6 |
| anything else | fail at once, no retry |

`GLOBAL_RETRY_UNIQUE = [operation_receipts_original_key]`. Families register theirs: K1 `resource_reservations_held_resource`, K2 `resource_reservations_integration_key`, `audience_grants_key`, `mailbox_messages_original` (delivery key), `mail_sent_pair_seq` (E-D1), `agent_names_active` (WS3 name races), one-pending request indexes (WS4). Bounded attempts (default 8, config) with jittered exponential backoff; exhaustion → `RetryExhausted`, never a silent drop.

### 3.5 Time (C7)

`tx.now()` issues `SELECT clock_timestamp()` **once per attempt, on first call**, and caches it for the attempt. Commands must call it only after locking their own mutable rows (C7); reads call it at snapshot start. A retry gets a new value. A pure-test clock replaces it in the fake session.

### 3.6 Unknown commit (v6 I04/I05)

If the connection dies during `COMMIT`, the executor re-runs the attempt on a fresh connection with the **same identity**. Its step-4 claim INSERT blocks on the in-doubt original's unique entry until that backend ends, then either finds the committed row (→ `Replayed`) or inserts (the original rolled back → execute normally). If the wait exceeds `lock_timeout` → `Unknown` (truthful; caller may look up later). No new identity is ever minted for resolution.

### 3.7 Group identity (for the feed, WS6)

Every committed executor transaction writes **exactly one** `operation_receipts` row. Keyless doors use a minted key (§3.3); mail-receive and other receiver transactions also run through the executor under minted keys; a lookup's fence transaction writes its `fenced` row. That row's `(ns_kind, ns_id, op_key)` is the transaction's **group identity**: the feed decoder sees it in the same pgoutput transaction and maps it to the commit position (v6 CHANGE-FEED:11; S3 E3), and command responses carry it. Two infrastructure transactions are not executor commands and write no receipt: the in-flight row insert/delete (§4) and service/read-service registration (§6); their tables are excluded from publication (§7). Receipt rows therefore grow with every write: P03 treats them as retained history, P06 owns retention, WS8 reports growth in churn-then-settle.

### 3.8 Connection factory

Every PostgreSQL connection in the store service and its helpers is opened through `orgtree_store::conn::Factory` and registered with the trace sink (purpose, backend pid, `backend_start`, role): executor pools, the reserved lookup/recovery pool, the liveness connection, read workers, WS6's replication and snapshot connections, and backup/maintenance connections (v6 PROFILING:19). This is the complete list Q-C5's hidden-access check reconciles against; a connection opened any other way is a defect.

## 4. Receipt lookup and in-flight rows (S3 §4.12, E-D13)

- Keyed calls: the store service inserts an **in-flight row** `(org, ns, key, service_incarnation)` in its own short transaction **before** step 2, and deletes it when `run` returns (any outcome).
- Service liveness (choice): each store-service process registers a `service_incarnations` row holding the backend pid and `backend_start` of one dedicated liveness connection it keeps open for its lifetime. An incarnation is live iff that `(pid, backend_start)` is in `pg_stat_activity`. No advisory locks, no timers. P08 owns the sweep that deletes dead rows; P03 lookup only ignores them.
- `lookup(org, ns, key)` (READ COMMITTED, never keyed itself): caller anchor → incarnation check (key's db incarnation ≠ current → `unknown/epoch_rotated`) → horizon check → in-flight row of a live incarnation → `running`, nothing fenced → `INSERT … state='fenced' ON CONFLICT DO NOTHING` (waits for an uncommitted original; on `55P03` → `running`) → inserted: `not_applied` (or `unknown/pre-transaction` for coverage classes that do work before the transaction) → not inserted: classify the committed row exactly like step 4.

## 5. Harness contract: pause points, controls, trace (merged with WS7 §1; lead rulings §3)

- **Feature.** One cargo feature, `qualification`, gates pause points, unsafe controls and the harness channel together. Without it `pause()` compiles to nothing, `controls::fire()` to `false`, and the channel does not exist. A test builds without the feature and confirms the pause symbol is absent.
- **Point names** `<family>.<verb>.<point>`. Generic points every operation gets: `admitted`, `begin`, `after_anchor`, `after_claim`, `before_commit`, `after_commit`, `before_effects`, and `stmt.<label>.before` / `stmt.<label>.after` for every labelled statement. Receipt lookup adds `receipt.lookup.after_inflight_check` and `receipt.lookup.before_fence`. Families add named points their schedules need (e.g. Q-ST4's name probe; errata A1 "after delete's snapshot, before its first lock").
- **Static lists and handshake.** Each family exports a static list of its points and controls. The harness handshake reports `{qualification, build_sha, points, controls}`; the harness refuses a plan naming an unknown point and any build reporting `qualification: false`.
- **Hook.** `trait PauseHook: Send + Sync { fn at(&self, p: &PausePoint) -> BoxFuture<HookAction>; }`, `PausePoint { name, family, verb, op: &OpIdentity, op_tag, attempt, backend_pid }`, `enum HookAction { Continue, Hold /* until RELEASE */, FailNext(sqlstate) /* next statement fails as if from the server */, DropConn /* close without COMMIT/ROLLBACK */, Sleep(ms) }`. For `kill_backend` the harness itself calls `pg_terminate_backend` on the pid reported in ARRIVED.
- **Channel.** A separate loopback endpoint on the store service, qualification builds only, per-run token. **WS7 owns the protocol** (plan JSON, ARRIVED/RELEASE, actions); **WS2 implements the server side.** ARRIVED = `{point, op_tag, operation_id, attempt, backend_pid, txid_if_assigned, seq}`. Unplanned points emit nothing and never block; a planned point never reached fails the run ("interleaving not achieved").
- **`op_tag`** (WS2 owns end to end): harness HTTP header `X-Orgtree-P03-Op-Tag` → door hook → channel frame `binding.op_tag` → `Binding.op_tag` → every trace record. Honoured only in a qualification build on an active prototype root; ignored everywhere else. Harness-driven schedule-grade writers set the field directly.
- **Unsafe controls.** Id `<schedule>.<variant>` (e.g. `Q-C4.remint_identity`). Site: `if controls::fire("Q-C4.remint_identity") { <unsafe path> }`. `fire` is true only when the current plan arms that id, and emits `control_executed{id, op_tag, operation_id}` at that site when it returns true. A control is accepted only with that record **and** a failed pass condition (G3). Each unsafe path is written exactly as the design's "unsafe control" column words it.
- **Provisional server-side relation check.** In qualification builds the executor runs one read-only statement labelled `trace.xact_stats` just before COMMIT, reading `pg_stat_xact_user_tables` for the current transaction and handing the rows to the trace sink. Provisional until WS7 confirms on a WS1 cluster that it catches reads, locks and writes per transaction; never run outside qualification builds unless WS8's overhead measurement allows it.
- **DECLARED-CONTACTS (r4, additive, lead ack 08:08Z).** Every family exports a static declared-contacts table beside its points and controls, and the harness handshake reports it:
  `"<family>.<verb>": { relations: { "<rel>": { modes: [...], required: bool } }, p01_contract, source }`.
  `required: true` marks the design's mandatory locks and reads: C3 anchors, C2a version bumps, the P8 head lock, the E7 receipt claim, E8 where it applies, and the `restriction_epoch` `FOR SHARE` of narrowing writers. `store_schema::DECLARED_SERVER_SIDE` entries merge into the declared set of every verb that touches their table. The executor's own generic steps are in every verb's table: the receipt claim (`operation_receipts`, INSERT/SELECT/UPDATE, required) and the in-flight row (`runtime_inflight`, listed as a separate infrastructure step outside the command transaction). WS7's oracle fails an undeclared observed relation or mode, and fails a committed attempt missing a `required` relation (v6's "omitted invariant read" control).
- **Harness protocol:** the server side implements WS7's `tools/p03/harness/protocol.py` (`orgtree.p03-harness/v1`, `origin/v3/p03-ws7-opus55` at `0eddb89`).
- **Trace sink** (always compiled; normal operation needs contact summaries too, v6 PROFILING:5): `trait TraceSink: Send + Sync { fn event(&self, e: &TraceEvent); }` with events for connection open (§3.8), admission, begin (isolation, backend pid), each statement (label, duration, rows, SQLSTATE), retry (reason, constraint), commit/rollback, effects, lookup answers, and `control_executed`. Every event carries `op_tag`, operation identity and attempt. Relations and lock modes are WS7's to derive; sequence numbers and loss counters are WS7's.

## 6. Output claims and restriction fence (r7 C5)

- `ClaimRegistry` (in memory, one per service incarnation): `register(principal, generation, org) -> ClaimHandle` **before** the snapshot; `handle.narrow(route)` after it (only narrows); `handle.emit(|| send) -> Result<(), Withheld>` atomically refuses if revoked, else marks emitting, runs, releases.
- `registry.restrict(&Restriction { id, org, principals: Set, epoch })`: revoke intersecting non-emitting claims, wait for emitting ones, then return — the caller acks the obligation. Coarse fallback `restrict_org_all` is allowed (r7 C5).
- Durable side (schema §7): `read_service_registrations` (one row per service incarnation, with its installed epoch), `restrictions`, `restriction_obligations`. Narrowing transactions insert one obligation per registered service in the **same** transaction (helper `restrict::record(tx, restriction)`); the service acks by updating its obligation row; Effective = all acked. **Ordering registration against capture (r3, lead ruling F1).** The org's `org_controls` row `family = 'restriction_epoch'` orders them, with the lock modes chosen so narrowing writers never block each other:
- every **narrowing writer** takes that row `FOR SHARE` **before** it reads `read_service_registrations`, and records the observed `version` as its restriction's `epoch` (an observation, not a counter — no uniqueness);
- a **registration** (rare: once per service start) takes it `FOR NO KEY UPDATE`, bumps `version`, inserts its registration row and installs that version before serving.

Why it is safe: a READ COMMITTED narrowing writer that waited on a registration reads registrations in a later statement and so sees the new service; a SERIALIZABLE (island) writer that waited gets `40001` because the registration **updated** the row, and its retry sees the service; a registration that waited behind a narrowing writer starts serving only after that restriction committed, so its snapshots already reflect it. This row joins Q-C3's measured share-lock fan-in list. It is exercised by **Q-C6's register-during-restriction variant**, whose unsafe control is registration without its lock.

## 7. Base schema slice (migrations owned by WS2 for M1)

Migration files: `engine/native/store-schema/migrations/NNNN_<name>.sql`, ascending, immutable once landed, sha256 recorded in `MIGRATIONS`. **Number ranges** so parallel workstreams never collide (choice): WS2 `0001-0099`, WS3 `0100-0199`, WS4 `0200-0299`, WS5 `0300-0399`, WS6 `0400-0499`, WS7 `0500-0599`. A family that needs to change a base table adds its own migration in its range. WS1's resumable runner applies `MIGRATIONS` in order as the migration role and records the minimum-writer version; the runtime role gets DML only.

| Migration | Tables (key constraint names in brackets) | Consumer |
|---|---|---|
| 0001 core | `store_incarnation` (one row: database id, incarnation; written by the WS1 custodian); `organizations`; `org_controls` (one row per control family: caps, killswitch, kiosk, cascade, defaults, directories, extern_holders, restriction_epoch — P6); `agents` (principal, current name, lifecycle); `agent_names` (active names **and** name reservations in one unique namespace [`agent_names_active`]); `authority_epoch` (narrow: lifecycle, generation, halted, audience_version, requests_version, version — C3/P1/P5/P7); `topology_edges` (parent, order, version); `scope_rows` (P3); `runtime_state` (P4, narrow); `audience_grants` [`audience_grants_key`]; `operation_receipts` [`operation_receipts_original_key`] + claimed-at-commit trigger; `runtime_inflight`; `service_incarnations`; `read_service_registrations`, `restrictions`, `restriction_obligations` | all |
| 0002 funding | `catalog_current` (share-locked version row), `price_catalog`, `issuer_capacity` (unpriced aggregates: child grant sum, seat count per tier — RN4), `funding_edges`, `kiosk_pool` (E8, only kiosk orgs) | WS3, WS4 |
| 0003 work | `work_items` (head: name, status, owner, creator, reviewer, rev, archived_at), `work_item_versions`, `work_participants`, `active_work_names`, `legacy_work_names` | WS3, WS4 |
| 0004 reservations | `resource_reservations` with K1 [`resource_reservations_held_resource`], K2 [`resource_reservations_integration_key`], K3/K4 checks | WS4 |
| 0005 mail base | `mailboxes` (head row P8: recv high-water, open/closed, owner seat), `mail_sent` [`mail_sent_pair_seq` on (org, source, dest mailbox, pair_seq)], `mail_pair_highwater`, `mailbox_messages` [`mailbox_messages_original`], `outgoing_intents`, `transport_intents` | WS5 (owns semantics), WS3/WS4 via Sent stub |
| 0006 requests, charters | `request_batches` (+ one-pending partial unique per asker/kind [`request_batches_one_pending`]), `charter_heads`, `charter_versions`; `runtime_claims` minimal; `folder_move_intents` [one pending per stack] | WS3, WS4, WS5 |
| 0007 publication | `publication_catalog` (version, relation, key, columns, replica identity, delete rendering, decoder version) — empty rows; WS6 fills | WS6 |

**Foreign-key rules (r3, lead rulings F2/F3; enforced by `store-schema` lints R9/R10 for every later migration too):**
- **No foreign key from a high-rate table to an org-wide row.** An FK check takes `FOR KEY SHARE` on the referenced row; on the one `organizations` row per org, overlapping key-share locks from every insert create MultiXacts (r7 C3 hot-row cost, on a row outside Q-C3). So `operation_receipts`, `runtime_inflight`, `mail_sent`, `outgoing_intents` (and the other tables in `store_schema::HIGH_RATE_TABLES`) carry `org_id` in their keys and composite FKs but **no FK to `organizations`**. Rarely inserted tables (`agents`, `org_controls`, catalog, pools, `work_items`, registrations, restrictions, legacy names) keep it.
- **No source-side foreign key to a receiver head.** `mail_sent` has no FK to `mailboxes`: it would key-share-lock the destination's P8 head row inside the sender's transaction (v6 SCHEMA-CATALOG:29), and the Sent row must outlive a deleted mailbox so the receiver refuses it under a closed-mailbox fence (Q-AM5, Q-E1 (b)). The destination is a captured identity (principal + mailbox incarnation). Receiver-side FKs to `mailboxes` are fine: the receiver already holds the head.

**Declared server-side statements (r3, lead note N1).** Triggers and functions run statements no labelled `Tx` statement covers; each is listed in `store_schema::DECLARED_SERVER_SIDE` with the relations it touches (today: the `operation_receipts_claimed_at_commit` trigger's one indexed read of the same key at COMMIT; the pure `resource_reservations_paths_ok` CHECK function). WS7's statement/relation map includes them so Q-C5 does not flag them (v6 PROFILING:19); a test fails if a migration adds a function or trigger without declaring it.

**Publication (v6 PROJECTION-RECOVERY:19).** WS6 fills `publication_catalog` and creates the publication in its range. A table with no catalog row is never published, and readiness fails if the catalog and the real publication disagree.
- *Published:* the domain tables of 0001-0006 — `organizations`, `org_controls`, `agents`, `agent_names`, `authority_epoch`, `topology_edges`, `scope_rows`, `runtime_state`, `audience_grants`, `catalog_current`, `price_catalog`, `issuer_capacity`, `funding_edges`, `kiosk_pool`, `work_items`, `work_item_versions`, `work_participants`, `active_work_names`, `mailboxes`, `mail_sent`, `mailbox_messages`, `mail_pair_highwater`, `outgoing_intents`, `transport_intents`, `request_batches`, `charter_heads`, `charter_versions`, `runtime_claims`, `folder_move_intents`, `resource_reservations` — WS6 may exclude further tables or columns it has no view for; and `operation_receipts` with **safe identifier columns only** (`org_id, ns_kind, ns_id, op_key, receipt_id, family, verb, state, decided_at`), never `result` or `fingerprint` (§3.7).
- *Excluded:* `store_incarnation`, `service_incarnations`, `runtime_inflight`, `read_service_registrations`, `restrictions`, `restriction_obligations`, `legacy_work_names` (fixed corpus), `publication_catalog`, and every projection table WS6 adds.

Column lists live in the migration files, which are reviewed against v6 SCHEMA-CATALOG as the plan's DDL checklist. Consumers may rely on the **table names, key columns and constraint names** above from M1; other columns may still grow within WS2's range until WS2's first landing.

## 8. Sent interface stub (WS5 owns the implementation)

```rust
pub struct SendRequest {
    pub source: MailSource,              // Agent{principal} | User | System  (System: no pair_seq, E1.2)
    pub dest: Destination,               // Resolved{principal, mailbox, mailbox_incarnation} | UserMailbox | External{handle}
    pub original_message_id: Uuid,       // stable across retries (part of the op identity)
    pub kind: MailKind, pub body: String, pub urgent: bool,
    pub grant: GrantEffect,              // None | ReplyGrant{grantee,target} | FirstContactUser | Extern
}
pub struct SentRecord { pub message_id: Uuid, pub pair_seq: Option<i64>, pub outgoing_intent: Uuid }

/// Called INSIDE the caller's command transaction (release-notify, status done/blocked, credit answer, staffing kickoff).
pub async fn record_sent(tx: &mut Tx<'_>, req: &SendRequest) -> Result<SentRecord, Refusal>;
/// Lock-order helper for grant-bearing sends (S3 E1.1 step 5, N4): take the grantee's authority_epoch
/// FOR NO KEY UPDATE at C4 step 3, BEFORE any other lock the caller takes after it.
pub async fn lock_grantee_for_grant(tx: &mut Tx<'_>, org: Uuid, grantee: Uuid) -> Result<(), CmdError>;
```

- Writes only source rows: `mail_sent` (with `pair_seq` = committed max + 1 for a paired source; collision → `mail_sent_pair_seq` retry), one `outgoing_intents` row, and the grant rows/epoch bump when `grant` says so. **Never** a receiver row (v6 I07). Registers a post-commit effect that hints the MPSC queue.
- M1 stub behaviour: writes `mail_sent` + `outgoing_intents` with `pair_seq`, supports `GrantEffect::None` and `ReplyGrant` (the P1 bump), and refuses the other grant kinds with `Unimplemented`. WS5 replaces the body behind the same signature; WS3/WS4 code against the signature only.

## 9. Store-service channel and the door hook

- Channel (choice): TCP on `127.0.0.1`, ephemeral port, length-prefixed JSON frames (u32 BE length + UTF-8 JSON). First frame is `hello {token}`; the per-boot token and port are in a descriptor file in the prototype root, ACL'd like `engine-attach.json` (`service_host.py:164-191`). Request frame: `{verb, org, binding{principal, generation, acting, key?}, args}`; response: the `Outcome` as JSON. Python side uses only `socket` + `json` (no new Python dependency).
- The door authenticates the caller exactly as today (`_agent_identity`) and forwards the bound principal; the service trusts the binding because the channel is authenticated. The service re-checks liveness/generation inside the transaction (C3 anchor) regardless.
- **Door hook** (the only existing-Python edit): one new module `engine/backend/orgtree/p03_door.py` and **one line** in `api.py` next to app creation: `p03_door.install(app)`. `install` returns without doing anything unless `ORGTREE_P03_PROTOTYPE_ROOT` is set **and** equals the resolved `ORGTREE_DATA` **and** that root carries the WS1 prototype-root marker with a matching data-root id. **Live-root refusal:** `install` also refuses — raises, never silently installs — when the resolved data root is `%APPDATA%\Orgtree v2\data` or anything under it, whatever the marker says (plan R11); a unit test fails if that check is removed. Only when all hold does it add a middleware that forwards the slice's verbs (`/api/agent` tool names in the slice, the human-send and inbox routes, the feed) to the store service; every other route is untouched. Inert = no middleware installed at all.
- **`op_tag` header rule:** the middleware copies `X-Orgtree-P03-Op-Tag` into `binding.op_tag` only when the store service's handshake reports `qualification: true`; otherwise the header is dropped (§5).

## 10. Not in M1

Family logic (WS3-WS5), the feed (WS6), trace collector and barrier framework (WS7), custodian and runner (WS1). DB-backed tests wait for the WS1 dev cluster and the P03 run lock. M1 code ships the executor with the fake session and pure tests: retry classification, identity reuse across retries, claim/replay/conflict/fenced classification, refusal rollback, effects-only-after-commit, timestamp-per-attempt, pause-point compile-out, output-claim revoke/emit races, migration ordering/checksums/lints.

## r1 questions — all agreed by the lead (rulings §2)

1. Standalone crates, no workspace — agreed, with the shared `CARGO_TARGET_DIR` and same-version locks (§1).
2. Migration ranges — agreed; WS1's runner takes `orgtree-store-schema` as a path dependency and applies `MIGRATIONS` in order as the admin role, checking each sha256 (WS1 to confirm by mail).
3. Liveness via `(pid, backend_start)` — agreed; Q-RL3's kill case must show a lookup ignoring a dead owner's rows.
4. Length-prefixed JSON over loopback — agreed.
5. `install(app)` — agreed, plus the live-root refusal (§9).
6. Sent stub None + ReplyGrant — agreed. **No schedule may be reported as passing against the stub**, and every trace event the stub emits carries `stub: true`.
