# P03 WS2 — M1 interface contract (executor API, base schema slice, Sent stub)

**Status:** DRAFT r1 for agreement with p03-lead-opus55. Nothing here is frozen until the lead's "agreed" is recorded as a decision on docket item `p03-ws2-store-core-schema-slice-command-executor`.
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

- Standalone crates with path dependencies, like the existing five; **no Cargo workspace** (choice: a workspace root at `engine/native/` would change how the existing crates build). Share one `CARGO_TARGET_DIR` per worktree to save disk and link memory. `CARGO_BUILD_JOBS=4`.
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

pub enum Decided<T> { Applied { output: T, effects: Vec<Effect> }, Refused(Refusal) }

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

`Tx` exposes only: `query/execute(label, sql, params)` (every statement is labelled; the label is the trace and pause identity), `now()` (§3.5), `pause(name)` (§5), `effects()` (register post-commit effects). No raw connection escapes, so there is no hidden statement.

`Executor::run(cmd, binding) -> Outcome<T>` is the only entry for mutations. `Executor::read(snapshot_fn)` runs a `REPEATABLE READ READ ONLY` snapshot with no receipt (r7 C5 / S3 E2).

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

## 4. Receipt lookup and in-flight rows (S3 §4.12, E-D13)

- Keyed calls: the store service inserts an **in-flight row** `(org, ns, key, service_incarnation)` in its own short transaction **before** step 2, and deletes it when `run` returns (any outcome).
- Service liveness (choice): each store-service process registers a `service_incarnations` row holding the backend pid and `backend_start` of one dedicated liveness connection it keeps open for its lifetime. An incarnation is live iff that `(pid, backend_start)` is in `pg_stat_activity`. No advisory locks, no timers. P08 owns the sweep that deletes dead rows; P03 lookup only ignores them.
- `lookup(org, ns, key)` (READ COMMITTED, never keyed itself): caller anchor → incarnation check (key's db incarnation ≠ current → `unknown/epoch_rotated`) → horizon check → in-flight row of a live incarnation → `running`, nothing fenced → `INSERT … state='fenced' ON CONFLICT DO NOTHING` (waits for an uncommitted original; on `55P03` → `running`) → inserted: `not_applied` (or `unknown/pre-transaction` for coverage classes that do work before the transaction) → not inserted: classify the committed row exactly like step 4.

## 5. Pause points and trace hook (WS7 interface)

- `tx.pause("<name>")` and the executor's own points: `exec.admitted`, `exec.begun`, `exec.after_anchor`, `exec.after_claim`, `exec.before_commit`, `exec.after_commit`, `exec.before_effects`, `lookup.after_inflight_check`, `lookup.before_fence`. Every labelled statement also yields `before:<label>` / `after:<label>`.
- Compiled only with cargo feature `pause-points` (off by default). Without it `pause()` is an empty inline fn and the hook type does not exist, so a production build cannot pause (checked by a test that builds without the feature and greps the symbol).
- Hook trait (WS7 implements): `trait PauseHook: Send + Sync { async fn at(&self, p: &PausePoint<'_>); }` with `PausePoint { family, verb, op: &OpIdentity, attempt: u32, name: &str }`. The hook blocks the attempt until its barrier releases.
- Trace hook (always compiled, cheap when a no-op sink): `trait TraceSink { fn event(&self, e: TraceEvent); }` with events for admission, begin (isolation, backend pid), each statement (label, duration, rows, SQLSTATE), retry (reason, constraint), commit/rollback, effects, and lookup answers. Relations and lock modes are WS7's to derive (pg_locks/pg_stat_activity); WS2 supplies the labels, pids and attempt numbers they join on. Sequence numbers and loss counters are WS7's.

## 6. Output claims and restriction fence (r7 C5)

- `ClaimRegistry` (in memory, one per service incarnation): `register(principal, generation, org) -> ClaimHandle` **before** the snapshot; `handle.narrow(route)` after it (only narrows); `handle.emit(|| send) -> Result<(), Withheld>` atomically refuses if revoked, else marks emitting, runs, releases.
- `registry.restrict(&Restriction { id, org, principals: Set, epoch })`: revoke intersecting non-emitting claims, wait for emitting ones, then return — the caller acks the obligation. Coarse fallback `restrict_org_all` is allowed (r7 C5).
- Durable side (schema §7): `read_service_registrations` (one row per service incarnation, with its installed epoch), `restrictions`, `restriction_obligations`. Narrowing transactions insert one obligation per registered service in the **same** transaction (helper `restrict::record(tx, restriction)`); the service acks by updating its obligation row; Effective = all acked. Registration takes `FOR SHARE` on the org's restriction epoch control row and installs it; narrowing writers update that row — this orders registration against capture (r7 C5 dependency; Q-C6 variant).

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
- **Door hook** (the only existing-Python edit): one new module `engine/backend/orgtree/p03_door.py` and **one line** in `api.py` next to app creation: `p03_door.install(app)`. `install` returns without doing anything unless `ORGTREE_P03_PROTOTYPE_ROOT` is set **and** equals the resolved `ORGTREE_DATA` **and** that root carries the WS1 prototype-root marker with a matching data-root id. Only then does it add a middleware that forwards the slice's verbs (`/api/agent` tool names in the slice, the human-send and inbox routes, the feed) to the store service; every other route is untouched. Inert = no middleware installed at all.

## 10. Not in M1

Family logic (WS3-WS5), the feed (WS6), trace collector and barrier framework (WS7), custodian and runner (WS1). DB-backed tests wait for the WS1 dev cluster and the P03 run lock. M1 code ships the executor with the fake session and pure tests: retry classification, identity reuse across retries, claim/replay/conflict/fenced classification, refusal rollback, effects-only-after-commit, timestamp-per-attempt, pause-point compile-out, output-claim revoke/emit races, migration ordering/checksums/lints.

## Questions for the lead (answer inline or by message)

1. Standalone crates, no workspace (§1) — OK?
2. Migration number ranges per workstream (§7) — OK, and does WS1's runner consume `store_schema::MIGRATIONS`?
3. Service liveness via the liveness connection's `(pid, backend_start)` in `pg_stat_activity` (§4) — acceptable for Q-RL3, given P08 owns the sweep?
4. Channel: length-prefixed JSON over authenticated loopback TCP (§9) rather than HTTP — OK?
5. Door hook as `install(app)` middleware, inert unless all three conditions hold (§9) — OK? It is one line in `api.py`.
6. Sent stub scope (§8): None + ReplyGrant only at M1 — enough for WS3/WS4 to start?
