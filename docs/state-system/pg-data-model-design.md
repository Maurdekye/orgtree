# Orgtree on PostgreSQL, built for it from the ground up: target design (rev 7.6)

Docket item: `v3-storage-keep-indexed-fields-in-real-postgresq` (drag-opus, 2026-10-02).

This is the target design. The user approved rev 3 on 2026-10-02 (decision 12 on the item), with
one condition. review-sol (Sol 6.1, effort max) reviews this design before the build starts, and
reviews the implementation again before the local alpha build. The companion
[`pg-columns-audit.md`](pg-columns-audit.md) measures today's costs on a copy of the live data.

**What changed:**

- **Rev 7.6: the durable turn request is the first lock tier (2026-10-03, B5).**
  Tools and result transactions hold the signed run's request row `FOR SHARE` on the native
  org connection before the action locks. Finish, cancellation and verified-dead reclaim take
  it `FOR UPDATE` before an agent, job or other row. The short `start_turn` wrapper takes this
  request lock before the unchanged jobs framework locks its job. Host forwarding commits
  pending-to-queued and job completion together, then inserts the app ticket separately;
  committed queued intent repairs that gap even if the job is already done.
  Verified-dead recovery fences each affected org durably in the app database,
  so a failed org never refuses the whole host or holds machine capacity for days.
  Retry and restart preserve the fence until the org's old requests commit lost.

- **Rev 7.5: a trigger locks only its own statement's rows (2026-10-03, after review A6 f8 and
  f9).** No product decision changes. Rev 7.4's statement-end Sent key still deadlocked twice: a
  key repair waited on a mail row another writer had edited (f8), and a forced deferred check
  took the revision row before a later mail write that waited on the owner's key row (f9). So
  §2.4 now also says that a statement-time trigger writes only link rows of its own statement's
  rows and takes no row lock, and that no code forces deferred checks; the static test checks
  both. A6's Sent tail key is no longer kept at all: the reader finds each recipient's first
  archive row when it reads (org migration 0008, `compat.sql._sent_ids`).
- **Rev 7.4: one lock order for every org-database writer (2026-10-03, after review A6 f7).** No
  product decision changes. Review found two lock-order deadlocks (stage 1-B f24, A6 f7). §2.4
  ("Lock order") now gives the order: advisory locks, then rows, then the revision row last, then
  only the rows locked under it. It also gives the rules that follow and the static test that
  checks them (`tests/test_orgdb_lock_order.py`). A6's Sent tail key is now settled when each
  statement ends, as legacy's trigger keeps it, instead of at COMMIT (org migration 0008).
- **Rev 7.3: notes from building stage 1-B (2026-10-03).** No design decision changes; these say
  how the parts were built and correct one line that departed from today's behaviour.
  - §6.2 item 3 says how the compatibility view is built: it answers the storage layer's own SQL
    statements from the org database, and a static test proves every statement is served.
  - §2.11 names the runtime's registry module (`orgdb.registry`): registry reads, the per-org
    pool, the process's lifecycle handle and Retry, which the parallel pieces build on.
  - §2.6: `GET /api/accounts` keeps today's placements exactly (every agent bound to an account,
    archived ones included). The earlier "live-only" line would have changed what the accounts
    screen shows.
  - §6.3 step 3 adds the accounts store: `registry.py` must read and write the app database's
    accounts tables before the switch turns on. Until then the converter's copy is only a
    snapshot of `accounts-registry.json`.
- **Rev 7.2: decision 21 (the user's ruling, 2026-10-02), replacing decision 19's f13 part.**
  - An agent's docket list header and its `orgtree_work list` totals count items that are not
    archived only. An agent's archived total comes only from an explicit archive request
    (`include_archived`), and is then the number of archived items served. The desktop (the
    user) keeps its archived and backlog totals, from `docket_counters` as before.
  - So an agent's totals no longer need the direct-item pass over its archived items (an early
    measurement grew in step with the viewer's own archived history: 10× gave about +10 ms). The
    two counters that served agents (`docket_subtree_counts`, `docket_anchor_counts`) and their
    upkeep go too, and a tree move touches no counter at all.
  - The history-growth rule (10× inactive history, a heavy agent's list call at most 5% slower at
    p95) still applies to the list call, and its benchmark is still run (Appendix A.3).
  - Also in rev 7.2: the converter keeps the org-level `sandbox` key (§5.2, "Keys the engine no
    longer uses"), because the former-sandbox credential catch-up that landed with the sandbox
    removal reads it after the upgrade.
- **Rev 7.1: review-sol approved rev 7 (`c083f85`)**, with one listed fix, which rev 7.1 makes:
  decision 20's test case in §5.2 (a snapshot folder copied by hand, its original deleted). Rev
  7.1 also cites decisions 19 (f13's fallback withdrawn, the benchmark mandatory) and 20 (the copy
  limit accepted). The coordinator then gave GO for the implementation.
- **Rev 7 answers review-sol's fourth review (of rev 6).**
  - The fourth review accepted f2, f11 and f17. It accepted f13's direct query (subject to its
    timing condition) and f15's option X, and reopened each of them on one point.
  - f15: a source path no longer counts as evidence of which org sent a file. A receipt moves
    only on its snapshot folder, or on a delivery key that recomputes its id (§5.2).
  - f13: the fallback counter for an agent's direct items is withdrawn, because it would make tree
    moves depend on history. If the direct query fails its timing condition in the prototype, the
    coordinator rules again on the measured numbers. The guards now say which paths keep the
    strict row bound, which one has the timing condition, and that tree moves are checked too
    (Appendix A.3).
  - Each answer is marked "rev 7" where it lives; §10 has the round-4 table.
- **Rev 6 answers review-sol's third review (of rev 5).**
  - The third review accepted f1, f6, f8, f10 and f16 (f9 moot), reopened f2, f11, f13 and f15,
    and added f17.
  - The biggest change is f17: an agent's identity is its own node, not the lineage it belongs to
    (§3.0, Appendix A.2–A.3).
  - The coordinator ruled on f13 (option B, with a performance condition) and f15 (option X).
  - The ignored-key rule now covers the per-org Docker sandbox removal as well as kiosk.
  - Each answer is marked "rev 6" where it lives; §10 has the round-3 table.
- **Rev 5 answers review-sol's re-review of rev 4.1, and adds decision 17.**
  - The re-review accepted f3, f5, f7, f12 and f14, and reopened or added f1, f2, f6, f8, f9, f10,
    f11, f13, f15 and f16. Each answer is marked "rev 5" where it lives; §10 has the table.
  - **Decision 17** (user): kiosk mode is deprecated and has no place in 3.2.0. No renderer mode,
    feed path, tables or columns. The converter does not convert kiosk state, which stays in the
    untouched legacy data and is listed in the report. This makes f9 moot.
- **Rev 4.1 adds decision 14** (user, 14:15Z: a tested upgrade path from 2.1.14, 3.0.9 and 3.1.0)
  to §3.9, §5.1, §5.3, §5.4 and §9. It changes one earlier statement. **3.2.0 no longer migrates
  the old database before converting it, and keeps the old org markers**, so the old build still
  runs on its untouched data, as decision 14 point 3 requires. Nothing else changed since rev 4.
- **Rev 4 answers review-sol's design review of rev 3.1** (commit `47ae47f`): 8 blocking findings,
  4 should-fix and 1 minor, all on the item. Each answer is marked "rev 4, finding fN" where it
  lives, and §10 maps every finding to its section. Rev 4 also adds what my preparation on copies
  found:
  - the converter reads through today's loader, and that loader writes nothing (measured);
  - 25 modules outside the storage layer query the old tables directly;
  - the section list must come from the code;
  - the side-file and accounts details.
- **Rev 3.1 was rev 3 plus the answers** (rev 3 is commit `9cfb8b1`). It adds the user's answers to
  Q9 and Q12 and the coordinator's rulings on Q10 and Q11, and what follows from them. Nothing
  else in the design changed. Sections touched:
  - §0 summary, §1 constraints;
  - §2.2 and §2.10–§2.13 (the `unavailable` org state, the admin connection, `max_connections`,
    migration failures, retry);
  - §2.4 (the turn queue is live; requests reach the process that owns a turn);
  - §2.5 (the screen feed carries the changed records);
  - §2.7 (every polling loop becomes a job);
  - §2.9 (the second engine process);
  - §4 (the mapping table);
  - §5 (a failed org no longer stops the start);
  - §6 (the release scope and landing order);
  - §7, §8.2, §9, §10.
- **Rev 3 replaced rev 2** (commit `833f6a2`). It followed decision 10 (one PostgreSQL database per
  org, plus a minimal shared app database) and decision 11 (adding or deleting a whole org is adding
  or dropping one body of data).
  - **Kept from rev 2:** the ground-up architecture (decision 7), the table design and the
    conversion checks.
  - **Changed in rev 3:** where the tables live, and everything that follows from it: connections,
    migrations, the screen feed, jobs, cross-org reads, the org lifecycle, the conversion and
    multi-process.

**Answers already given:**

| Question | Answer |
|---|---|
| Q1 | one JSON column per shapeless payload that nothing filters inside |
| Q2 | `timestamptz` |
| Q3 | keep the old data for one release |
| Q4 | `numeric` for mixed numbers |
| Q5 | stages land on v3 one at a time |
| Q6 | surrogate keys and tombstones |
| Q7 | a dedicated `orgtree` schema in every database (§3.0; rev 4 withdraws rev 3.1's "dedicated databases" reading, finding f14) |
| Q8 | change log kept 24 h, and at least 10,000 revisions |
| Q9 (user) | **everything at once.** 3.2.0 converts the data and also ships the live turn queue with leases, a second engine process, a renderer that applies changes without refetching, and every remaining polling loop moved to jobs (§6.1) |
| Q10 (coordinator) | only the org-lifecycle module gets the admin connection, and only inside the engine host (§2.11) |
| Q11 (coordinator) | `max_connections` 100, written by the custodian for fresh installs and upgrades (§2.11) |
| Q12 (user) | **start without the failed org.** The converted orgs start. The failed org is shown as unavailable with the reason and can be retried later. Its old data stays untouched (§2.13, §5.2) |

Decision 6 still stands: no build or publish until the whole data-model rewrite is in, apart from
the local alpha. Decision 9: the release line is 3.2.0, and the local alpha build is
3.2.0-alpha.0.

## 0. Summary

**Layout** (§2.10):

- **One database per org** (`orgtree_org_<n>`). It holds everything the org owns: agents, docket,
  mail, questions, audiences, watchdogs, documents, reservations, logs, its change log, its jobs,
  and the org-owned rows that today sit in machine-level side files (reply events, file
  deliveries).
- **One small app database** (`orgtree_app`). It holds only what cannot live in any org's database:

  | Table | Holds |
  |---|---|
  | `orgs` | the registry of orgs and their databases |
  | `accounts` | the machine-wide billing accounts, their limit marks and spend (accounts restricted to one org live in that org's database, rev 4) |
  | `turn_tickets`, `turn_admission` | the machine-wide fair turn queue |
  | `engine_instances` | engine processes, for leases |

  An org's whole footprint there is its registry row, plus its turn tickets while they exist. Both
  are removed in the same step as the org.
- **Importing an org** is creating one database and adding one registry row. **Deleting** it moves
  that database and the org's folder to the trash; purging the trash drops them (§2.13).

**Architecture** (unchanged from rev 2):

- PostgreSQL is the only source of truth.
- Each action is one short transaction over only its rows.
- Integrity is enforced by the database.
- Partial indexes keep history out of hot paths.
- Turn admission and background work are `SKIP LOCKED` queues.
- A numbered change log drives the screen feed.
- Code is split into domain modules.
- The engine is stateless.

**One data migration.**

- On upgrade, the engine creates the app database and one database per org.
- It converts each org from today's layout and reads everything back.
- An org that does not convert, or does not match on read-back, is left out (Q12). It shows as
  unavailable with the reason and can be retried. The other orgs start. Only a failure that no org
  can run without (the app database, the accounts) still stops the start.
- Today's database is not modified at all, so rolling back to 3.1.0 is "run 3.1.0 again" (§5.3).
- A 2.1.14 install takes the same path after the existing first-launch import. That import now
  holds back only the org that fails, instead of refusing every org (§5.1).

**What ships in 3.2.0: everything** (Q9, §6.1). That means the new data model, plus the live turn
queue, a second engine process, a screen feed the renderer applies without refetching, and jobs in
place of every polling loop.

**What the move to one database per org costs** (measured on my dev cluster, §8):

| Cost | Value |
|---|---|
| Opening a connection | ≈17 ms |
| Memory per idle connection | ≈4 MB private |
| Creating an empty database | 0.63 s |
| Dropping a database | 0.26 s |
| Dumping one org / restoring it | 2.2 s / 5.7 s |
| Every org-internal lookup and write | the same as in rev 2's prototype, re-measured inside a dedicated database |

## 1. Starting point and constraints

- **Today.** One PostgreSQL database (`orgtree`), with one schema per org (`org_<n>`) holding five
  key+JSON tables and 18 trigger-kept side tables, plus `public.orgs`, `public.receipts` and the
  migration bookkeeping. Around it sit machine-level files:
  - `accounts-registry.json`, `app-settings.json`;
  - `reply-events.sqlite3`, `file-deliveries.db`, `chat-window-index.sqlite3`;
  - the mail hub's folder;
  - each org's marker in `orgs/` and its workspace and scratch folders.
- **The user's rules** (decisions 2–11). Foreign keys for many-to-one; link tables for many-to-many;
  no embedded lists; a normalized design. Conversion from v3.0.9 and from v2.1.14, rehearsed on
  real data. No build or publish until the rewrite is in, apart from a local alpha after the first
  prototype. The ground-up architecture. One database per org and a minimal app database, with an
  org being one body of data.
- **Hard constraints.**
  - Old data must not be lost.
  - A check that fails stops what it covers, with a clear reason. One org's failure keeps that org
    from starting while the others start (Q12). A failure in the app database or the accounts
    stops the whole start.
  - The 2.1.14 first-launch importer (`tools/pypg/pgimport.py`) writes into today's layout.

## 2. Target architecture

### 2.1 The unit of work: one short transaction per action, inside one org

Every operation (an API call, an agent tool call, a job) is a function in a domain module. It runs
in one transaction **on its org's database**:

```python
def move_agent(t: OrgTx, agent: AgentRef, new_parent: AgentRef | None, actor: Actor) -> MoveResult:
    a = t.agents.lock(agent)                 # SELECT … FOR UPDATE on the rows it will change
    p = t.agents.get(new_parent)
    rules.check_move(a, p, actor)            # the business rule, in Python, on these rows only
    t.agents.set_parent(a, p)                # UPDATE agents SET parent_id = …, row_version + 1
    t.feed.changed("agent", a.id)            # appended to `changes` at commit (§2.5)
    return MoveResult(...)
```

- **`OrgTx`** is a transaction (READ COMMITTED) on a connection from that org's pool (§2.11).
- **Committing** bumps the org's revision and writes the change-log rows.
- **Retries.** Serialization failures and deadlocks retry the whole function. Functions are pure
  apart from the database, as `org_tx_call` already requires.
- **Idempotency.** Operation keys (today `public.receipts`, keyed by org) move into the org's own
  database.
- **Locks are taken in one order:** agents by id, then items by id, then mailboxes, then other rows.
- **Business rules stay in Python** and run on the rows the function read. Rules over sets
  (ancestry, free credits, docket access) ask the org database (§2.6).

**No transaction ever spans two databases.** The few actions that touch two (cross-org mail,
starting a turn) are written as two steps. The first step records the intent durably, and the
second is an idempotent job (§2.7). Nothing relies on both commits happening together.

### 2.2 Integrity enforced by the database

| Rule | How (inside one org database) |
|---|---|
| Every link points at a real row | foreign keys. The database itself scopes everything to the org, so keys carry no `org_id` |
| Valid statuses and kinds | `CHECK (… IN …)` on every enumerated column |
| Agent names unique | `UNIQUE (name) WHERE state <> 'deleted'`. A deleted agent keeps a tombstone row, so historical references stay valid keys (§3.0) |
| Docket slugs unique and never reused | `UNIQUE (slug)` + `retired_slugs(slug)`, checked in the create transaction |
| No overlapping reservations | `UNIQUE (resource) WHERE state = 'held'` (today's rule), `UNIQUE (integration_key)` |
| No loop in the tree | one topology lock per org plus a deferred check at commit (**Tree changes**, below). It refuses; it derives nothing. |
| The database belongs to this org | a one-row `org_identity(org_uuid, slug)` table. The engine compares it with the registry row on every pool open, so a database restored under the wrong name is not served: the org becomes `unavailable` (step `identity`, §2.13). |
| Counts and sequences sane | `CHECK`s |

Across databases, integrity is by construction. The app database never holds org content, so there
is nothing to keep consistent with it except the registry row and the small references listed in
§2.10. All of those are deleted with the org.

**Tree changes (rev 4, finding f1; corrected in rev 5).** Checking only the moved row's new
ancestors is not enough under READ COMMITTED.

- **The race.** Start with A under B and C under D, where B and D are top-level. One transaction
  moves B under C; another moves D under A. Each change walks up from its new parent, sees the
  other's old (top-level) state, and passes. The result is the loop A→B→C→D→A.
- **PostgreSQL limits.** Constraint triggers are row-level only. A deferred trigger's `NEW` is the
  row as that one statement left it, not the final row. And a session setting is something any
  caller can set, so it cannot prove that a lock is held.

The protocol (rev 5):

1. **The guard takes the lock itself.** One constraint trigger, `DEFERRABLE INITIALLY DEFERRED`,
   fires `AFTER INSERT OR UPDATE OF parent_id ON agents FOR EACH ROW`. At commit it first takes
   the org's topology lock, `SELECT … FROM org_topology WHERE singleton FOR UPDATE`, and only
   then checks.
   - Nothing set by the caller is trusted. Whoever changes a parent, by any path, is serialized by
     the guard.
   - Domain functions that reshape the tree take the same lock at their start too, so their
     business rules see a stable tree. Taking it twice in one transaction is harmless.
2. **It judges the final tree.**
   - The check re-reads the row by key (`SELECT parent_id FROM agents WHERE id = NEW.id`), and
     skips a row deleted later in the transaction.
   - It walks up from the row's current parent by primary key, with a depth guard of 64, and
     raises if it meets the row.
   - So a transaction that passes through a temporary loop (A under B, then A back to the top
     level) is judged by its final, valid tree.
3. **Inserts are covered.**
   - The trigger fires on `INSERT` too, and `CHECK (parent_id IS DISTINCT FROM id)` refuses a
     self-parent at once.
   - One statement that inserts two new rows pointing at each other is caught when either row's
     check walks up.
   - The converter's bulk `COPY` fires the same trigger (about 1,400 agents per org, a few
     milliseconds). It also runs one whole-table cycle query before it publishes an org.
4. **Why it is safe.** The lock row is held until commit. A second transaction's check waits for
   the first to commit, then walks a tree that already contains the first one's changes: under
   READ COMMITTED each statement in the trigger takes a new snapshot. Two changes can never both
   validate against each other's old state.
5. **Cost** (inferred, to be measured in the prototype). Tree changes are user actions and rare.
   The check is at most the tree depth (6 today) in key lookups per changed row. A 400-agent
   re-parent adds at most 2,400 lookups at commit.
6. **Tests (§9):**
   - the original two-session race, in both orders;
   - a transaction with a temporary loop and a valid final tree, which must commit;
   - a self-parent insert and a two-row cyclic insert, which must fail;
   - a direct `UPDATE … SET parent_id` racing a locked move, serialized by the guard's own lock;
   - three mutants, each of which must make a test fail: the guard without its lock, the check
     reading `NEW` instead of the row, and the trigger without its `INSERT` event.

### 2.3 History costs nothing

Partial indexes cover active rows only:

| Table | Active rows indexed |
|---|---|
| agents | live |
| docket items | open (`archived_at IS NULL`) |
| mail | not yet delivered |
| jobs | queued |
| questions | open |

Archived rows are reached only by key, or by `LIMIT`ed index ranges. The tests seed 10× history and
require the same statement counts and rows read (§9). One read is the exception (rev 7, decision
18): the pass over an agent's own direct docket items, for its totals, is held to a timing
condition instead (Appendix A.3).

### 2.4 Concurrency

- **Inside an org:** row locks on exactly the rows an action changes or decides on, plus
  `row_version` compare-and-set on every mutable row. The docket's visible `rev` stays its own
  column.
- **Across orgs: turn admission.** Today `turnslots.FairSlots` is in memory: at most 16 turns at
  once across all orgs, first come first served within an org, round-robin across orgs. This is
  the one scheduling decision that is machine-wide by definition, so it lives in the app database.
  It is live in 3.2.0 (Q9): `turnslots.FairSlots` is removed, with the same limit and the same
  fairness.

**The turn protocol (rev 4, finding f2).** Rev 3 made a ticket unique only while it was waiting
or running. A retry after the turn had finished could therefore queue the same turn again. A late
start could also land after a halt, and a paused process could still be running its provider after
its lease expired. Rev 4 gives every turn a durable identity, numbered claims and a termination rule:

1. **A turn request is a row, in the org database.** The org transaction that decides an agent
   should run inserts `turn_requests(request_id uuid PK, agent_id, reason, state CHECK (pending,
   queued, running, stopping, done, cancelled, lost), claim_epoch, created_at, ended_at,
   end_reason)`. In the same transaction it writes a `start_turn` job whose dedupe key is the
   `request_id`. The id is minted once and never reused.
2. **The ticket is keyed by that id, forever, and is made by a durable two-step handshake (rev 6).**
   - `turn_tickets` in the app database has `request_id UNIQUE`, with no partial condition, plus
     `UNIQUE (org_id, agent_id) WHERE state IN ('waiting', 'running', 'stopping')`, so an agent
     never runs two turns at once (§3.1).
   - The `start_turn` job runs two steps, and is retried as a whole until both are done:
     1. *Org side:* compare-and-set the request from `pending` to `queued`. If it is already
        `queued`, carry on: this is a retry of the same request. In any other state (cancelled,
        or already running or finished) the job ends without a ticket.
     2. *App side:* `INSERT … (request_id, state 'waiting') ON CONFLICT (request_id) DO NOTHING`.
   - **Both crash points are safe.**
     - A crash after step 1 leaves the request `queued` with no ticket. The retried job finds
       `queued`, carries on, and inserts the ticket.
     - A crash after step 2 leaves both. The retry's insert does nothing.
     - A retry after the turn has finished meets a later state in step 1, and its insert could
       not succeed anyway.
   - **A ticket never exists for a `pending` request**, because step 1 always commits first. So
     admission claims only tickets whose request is `queued`, or was cancelled after that, which
     start catches (step 4).
3. **Cancellation is durable for that request, and a running turn keeps its slot until it has
   stopped (rev 5).**
   - *Before the provider is launched* (the request is `pending` or `queued`; the ticket is
     missing, `waiting`, or admitted but not yet started):
     - The request becomes `cancelled` in the org database, and the ticket is upserted as
       `cancelled` by `request_id`. Both are terminal, and an admitted slot is freed at once:
       nothing was launched, and start's compare-and-set (step 4) now fails.
     - A delayed `start_turn` meets the cancelled request in its step 1, or the cancelled ticket in
       its step 2, and does nothing, whichever order they run in.
     - Cancellation and start both write the org request row, so they are serialized. If start's
       compare-and-set commits first, the request is `running` and the cancellation takes the
       running path below.
   - *While running*:
     - The request and the ticket become **`stopping`**, and `claim_epoch` is raised in the same
       step.
     - A `stopping` ticket still occupies its slot and still reserves its agent. Admission counts
       `running` and `stopping`, and the one-turn-per-agent index covers `waiting`, `running` and
       `stopping`.
     - Only when the owner has stopped its provider does it move the ticket and the request to
       `cancelled`, matching its own `lease_owner`. If it does not within the timeout, the host
       terminates it (step 6) and does the same.
   - *The two halves.* The org half is written first, because it is what authorizes the run's
     operations (step 4); then the app half. The host's heartbeat pass mends a crash in between:
     an org request that is `stopping` or `cancelled` while its ticket is still `running` moves the
     ticket to `stopping`, and the owner is told.
   - Today's `wake()`-after-cancel calls disappear.
4. **Claims are numbered, and run operations check the run's current state.**
   - Admission locks the single `turn_admission` row (the limit and the org served last), counts
     the `running` and `stopping` tickets, and picks the next waiting ticket in fair order with
     `FOR UPDATE SKIP LOCKED`.
   - It sets the ticket `running`, increments `claim_epoch`, and records `lease_owner` (an
     `engine_instances` row).
   - **Start validates the org request.** Before it launches the provider, the owner moves the org
     request from `queued` to `running` with the new epoch, by compare-and-set. If the request was
     cancelled in between, the compare-and-set fails, nothing is launched, and the ticket becomes
     `cancelled`.
   - **Every operation of the run** (its result rows, and the agent's own tool calls under it)
     starts its transaction with `SELECT … FROM turn_requests WHERE request_id = $1 AND
     claim_epoch = $2 AND state = 'running' FOR SHARE`. The run identity reaches the provider
     process at start, beside today's agent token, and every tool call presents it.
     - An operation that holds that share lock before a cancellation commits finishes normally:
       the cancellation waits for it.
     - An operation that starts after the cancellation is refused, because the state is no longer
       `running` and the epoch has moved.
     - Finish matches `(request_id, claim_epoch)` the same way.
   - A stale process therefore changes nothing, and it learns it lost the claim.
5. **A lease belongs to a process, not to a turn.** A ticket's lease is valid while its owner's
   `engine_instances.heartbeat_at` is fresh, every 5 s, expiring after 30 s.
6. **The old run must be dead before its slot is reused.** Only the engine host reclaims, and only
   in this order:
   1. Its own child, the worker (§2.9), has missed its heartbeat.
   2. The host terminates the worker process, checked by pid and start time.
   3. Every engine process starts its provider processes inside its own Windows job object with
      kill-on-close, as `process_lifetime.py` already does for the whole engine tree. So the
      worker's providers die with it.
   4. Only then does the host install a durable app-database recovery fence for each affected
      active or unavailable org, mark the instance dead and its tickets `lost`, and raise
      `claim_epoch`, in one app transaction. The fence refuses admission and every old run
      identity across restart, Retry and restore. Its verified-dead tickets no longer hold
      machine-wide slots, even when the org cannot be opened for days. In separate, bounded
      org transactions its old requests become `lost` with raised epochs. Lift that org's
      fence only after those commits; a failure leaves the fence and is retried by the host
      heartbeat when the org is openable. Only active orgs are opened; an unfinished lifecycle
      operation belongs to lifecycle takeover (§2.13 rule 2), rather than turn recovery.
      Other orgs start and admit normally. The org's existing restart rules alone decide
      whether to create a new request, with a new id.
   5. If the host itself dies, the existing guardian kills the whole tree before it releases the
      data-root lock. A new host can start only after that.

   So no provider of a reclaimed turn can still be running.
7. **External effects are keyed.**
   - The ticket insert is keyed by `request_id`.
   - Cross-org delivery is keyed by the message's id (§2.7).
   - A job retried after a crash repeats nothing.
8. **Requests reach the process that owns the turn through the databases.**
   - Mid-task mail is pulled by the running turn: its hook calls the engine's steer door, or the
     lane's own loop asks in-process. Both read pending rows from the org database, so any process
     can serve them.
   - An interrupt, halt or retire must act on the provider process itself. It is written as in
     step 3 and announced with `NOTIFY turn_tickets` in the app database.
   - The process named in `lease_owner` stops the provider it started, then moves the ticket and
     the request from `stopping` to `cancelled` (step 3).
   - A process that misses the notice still sees the state at its next heartbeat, which re-reads
     its tickets. Nothing depends on a notice arriving.
   - Per-turn memory that today lives in `supervisor.state(slug, nid)` stays in the owning process
     only while it is a cache. Anything another process must see becomes a row.
9. **Tests (§9).** Each is a two-process or fault-injection test:
   - a crash after the ticket insert, and a retry of the job after the turn has completed;
   - a delayed start against a halt, in both orders;
   - a paused worker past its lease, which the host must kill before reclaiming, while its
     provider stays stopped;
   - a stale finish with an old epoch;
   - two processes admitting under the slot limit;
   - added in rev 5:
     - a paused owner after a cancellation and before its stop acknowledgement (the host kills it);
     - a new request for the same agent while it is `stopping` (it waits);
     - a cancellation at a full slot limit (the slot stays taken until the provider has stopped);
     - a cancellation between admission and start (nothing is launched);
     - an operation presented with the cancelled epoch (refused), and one already in progress
       when the cancellation came (it finishes first);
   - added in rev 6, each with a barrier or an injected crash: immediately before and after the
     org `pending → queued` step and the app insert; a retry of the job after completion; and a
     cancellation at every boundary (pending, between the two steps, waiting, admitted but not
     started, running).

**Lock order inside an org database (rev 7.6, including B5's run fence).** Review found two lock-order
deadlocks: stage 1-B f24 (the settings fence against node locks) and A6 f7 (a commit-time key
rewrite against the revision row). Every writer of an org database takes its locks in this order:

1. **The bound turn request first.** Tools and result writers take its exact request, agent,
   owner, token and epoch in `state = 'running'` `FOR SHARE` on the action's native org
   connection. Transitions take the request `FOR UPDATE` before agents, jobs or other rows.
   A cross-org action holds its origin request's share lock through the action; its signed
   identity is never relabelled as the destination. The `start_turn` domain wrapper locks
   the request before `jobs.execute`. An already-in-progress operation may finish before
   cancellation obtains this lock; an old epoch presented later is refused before the body.
2. **Then advisory locks.** In `org_tx` (`orgdb.compat.tx`): the org lock (shared, or exclusive
   for a whole-org transaction), then the settings fence when the plan may write a settings key
   (f24), then the node, key and `(dict log, owner)` locks in the plan's sorted order, then the
   operation receipt's lock. Outside `org_tx`, an insert that needs its key or name absent takes
   that key's or name's advisory lock before it looks (`rows.fence_key`, `rows.lock_doc_key`,
   the agent-name lock).
3. **Then rows, in a fixed order per writer.** `org_tx` locks its plan's rows `FOR UPDATE` /
   `FOR SHARE`: agents by physical id, docket items, mailboxes, then other planned rows.
   Its statements then write. A body that needs a row outside its plan raises `Widen`:
   the transaction rolls back and reruns with the wider plan, so no row is locked late. A
   compare-and-set locks the one row it decides on. The job queue claims by `(run_at, id)` with
   `SKIP LOCKED`. Several orgs: one transaction per org, in org_id order. **A statement-time
   trigger writes only the link rows of its own statement's rows** (a table with a foreign key
   to the trigger's table: `event_refs` for `events`, `docket_question_links` for `asks`), and
   takes no row lock (rev 7.5). So a writer's locks are the rows its own statements write, in
   its own order, and nothing a trigger adds. A value derived from other rows, such as A6's Sent
   tail key (a recipient's first archive row), is computed by the reader; rev 7.4 kept that key
   on every mail row, and its repair locked a shared owner row and rewrote rows other writers
   hold (review A6 f8, f9).
4. **The revision row last.** `orgtree.org_revision` is locked only by:
   - the save seam, `OrgDbConn.on_save_commit`, immediately before COMMIT;
   - the deferred constraint triggers, which run at COMMIT: 0006 `foreground_flush` (the node,
     catalog and view counters; 0007's `docket_rev` uses it too), 0008 `events_count_flush`,
     0012 `docket_archive_flush`;
   - a job handler, as its last statement (`orgdb/jobs.py`).

   **No code forces deferred checks** (`SET CONSTRAINTS ... IMMEDIATE`, rev 7.5): that runs the
   commit-time triggers at once, so the revision row would be held while the transaction's later
   statements still lock rows, and a writer committing with one of those rows waits for the
   revision row: review A6 f9. A caller that does it anyway has entered its commit, as after
   `on_save_commit`: its counts stay right (the BEFORE statement triggers defer each flush
   again), but it must write nothing that can wait. A lock timeout after the revision row is not
   used to enforce this: `NOTIFY` takes one lock for the whole cluster at COMMIT, after the
   revision row, so ordinary commits would fail on it.
5. **After the revision row, only the rows locked under it:** `foreground_parent_counts` (0006)
   and `docket_counters` (0012). A transaction holding the revision row waits for nothing else.

Rules that follow:

- A deferred trigger writes or locks only the revision row (first) and the rows under it. Work at
  COMMIT that would need any other row is not allowed. A derived key is then a generated column,
  is kept at statement time under the writer's own row locks, or is computed by the reader.
  Example: A6's Sent tail. Round 2 kept its recipient key on every mail row and rewrote the
  owner's other rows at COMMIT, after the revision row (f7). Round 3 did that when each statement
  ended, under a shared owner row, and deadlocked against mail-row writers (f8) and a forced
  check (f9). Round 4 keeps no key: the reader finds it (rev 7.5).
- No statement-time trigger or other SQL function writes or locks the revision row or the rows
  under it.
- The engine's Python writes or locks the revision row only in `OrgDbConn.on_save_commit`, and
  never writes the rows under it.
- A statement-time trigger, with every function it calls, writes only link rows of its own
  statement's rows and takes no row lock; no other function writes; nothing forces deferred
  checks (rev 7.5).
- `tests/test_orgdb_lock_order.py` checks these rules statically (no database) over every org
  migration and the engine's Python. Its controls must fail: f7's round-2 settling, round 3's
  statement-time owner keys (f8, f9; the test fails on `4afea43`'s own migrations), a link table
  of another table, a writing trigger on a table only `format()` names, a writing plain function,
  a statement-time revision bump, a counter row taken before the revision row, a forced check,
  and a Python writer. Adding a table under the revision row, a Python writer of it, or a
  writing trigger means changing that test.
- Interleavings the static check cannot see have concurrency tests: f24 (`LockBlock` in
  `tests/test_orgdb_compat_pg.py`), f7 (`OwnerKeys.test_a_save_and_a_native_mail_writer_with_its_event_both_commit`),
  f8 (`OwnerKeys.test_a_first_row_removal_and_an_edit_then_removal_of_another_row_both_commit`) and
  f9 (`OwnerKeys.test_a_forced_event_check_then_a_mail_removal_and_an_audited_append_both_commit`).

### 2.5 The change log and the screen feed: per org database

**Storage.**

- Each org database has `changes(rev, pos, entity, entity_id, op)` and a one-row
  `org_revision(rev, floor)`.
- A transaction takes the revision row's lock **last**, just before commit (§2.4, "Lock order").
  Revisions are therefore handed out in commit order with no gaps, and the lock lasts only the
  commit.
- `floor` is the lowest revision whose changes are still complete (retention, below).
- `NOTIFY` is per database, which suits this layout. Each org's transactions send
  `NOTIFY org_rev, '<rev>'` in their own database.

**The cursor and the snapshot rule (rev 4, finding f8).** Rev 3 read the changed records in a
later transaction than the one that chose them. A client could then hold old records under a
newer cursor. Rev 4 fixes the rule:

1. **A cursor is `(org_uuid, incarnation, rev)`.** `incarnation` is a uuid in `org_identity`. It is
   minted when the org database is created, and minted again whenever a database replaces it
   under the same org (an import, or a restore taken as a clone). A cursor with another uuid or
   incarnation is answered with a full load. Revision numbers of two different databases can
   never be confused, even under a reused slug.
2. **A baseline is one snapshot.** A full load runs in one `REPEATABLE READ READ ONLY` transaction.
   It reads `org_revision.rev` = R and every baseline record in the same snapshot, and returns
   `(records, cursor R)`. A transaction is either wholly visible in the snapshot or not at all,
   and it raises the revision in the same commit as its data. So R is exactly the last revision
   whose effects the records contain.
3. **Catch-up is one snapshot with explicit bounds.** `GET /api/orgs/{slug}/changes?after=N` runs
   in one `REPEATABLE READ READ ONLY` transaction:
   1. Read `rev` = R and `floor`.
   2. If N < `floor`, answer `reset`, and the client does a full load.
   3. Otherwise, select the distinct `(entity, entity_id)` with `N < rev <= R`.
   4. For each, read its state **in the same snapshot**. If it exists, the frame carries its
      body; if not, the frame is a tombstone.

   The answer is one coalesced frame `{from: N, to: R, upserts, tombstones}`. The stored `op` is
   not used to decide the result: the state at R decides. An `UPDATE` followed by a `DELETE` is
   therefore a tombstone, never a stale body.
4. **Live frames use the same query, and a client applies any frame that covers its cursor
   (rev 5, finding f8).**
   - The host keeps one server cursor per org it serves. On `NOTIFY` it runs the catch-up query
     from that cursor, and pushes the frame `{from, to, …}` to that org's clients.
   - **Why an overlapping frame is safe to apply whole.** Every body in a frame is the record's
     state at `to`, and every record changed in `(from, to]` is in it. Take a client whose
     cursor c lies anywhere in `[from, to)`:
     - a record changed after c is in the frame, with its state at `to`;
     - a record changed only between `from` and c is overwritten with its state at `to`. Nothing
       changed it after c, so that is the state the client already holds.

     Applying the whole frame therefore gives exactly the state at `to`.
   - **The client rule:**
     - if `to <= c`, ignore the frame (old or a duplicate);
     - if `from <= c < to`, apply it and set c to `to`;
     - if `from > c`, ask for catch-up from c (a gap).
   - **One ordered pipeline per client.** Baselines, catch-up answers and live frames are all
     "state at `to`" units. The client applies them in arrival order under the same rule, so a
     slow, older answer is discarded and can never overwrite newer state. While a baseline is in
     flight, live frames are buffered, then put through the rule against the baseline's cursor.
   - A client that joins between commits (cursor 103, while the host's last frame ended at 100)
     applies the next frame, 100→105, under the rule. If no commit comes, 103 is already current.
5. **A lost `NOTIFY` cannot strand anyone.**
   - Notifications are lost only when the listening connection drops. On every reconnect, the
     listener first runs catch-up from its server cursor.
   - A client that reconnects always asks for catch-up from its own cursor, even when no later
     commit arrives to reveal a gap.
6. **Retention is a race-free boundary.**
   - A prune job deletes changes below a new floor and raises `floor` in the same transaction.
   - A catch-up snapshot sees either the old rows with the old floor, or the new floor (and then
     answers `reset`). It never sees a partial prune.
   - Retention stays 24 h and at least the last 10,000 revisions (Q8).

**Who receives frames (decision 17, which makes finding f9 moot).**

- The desktop is the only audience. It is the user, who may read everything in the org, and it
  applies record frames with no refetch and no polling (Q9).
- Kiosk mode is deprecated and does not exist in 3.2.0: there is no public renderer, no public
  gateway, and no feed path, tables or columns for it.
- Agents do not use the websocket.

So no audience has partial visibility, and there are no visibility transitions to protect.

**The org list** (orgs created, deleted, renamed, unavailable) is the app database's own feed:
`NOTIFY app_orgs` from the registry transactions, one listener per engine process, and the same
snapshot rule over a registry revision.

**This replaces** the per-process frame `rev` (`api._sync_revs`), the coalesced `changed` broadcast,
and the whole-tree rebuild after every commit (1.2–1.45 s on the live copy today).

**Tests (§9).**

- Two-session barrier tests: a full load against a concurrent update and a concurrent delete, and
  a catch-up against a write between its reads.
- A killed listener connection.
- A prune racing a catch-up.
- Reordered and duplicate frames.
- An org replaced under the same slug.
- Added in rev 5:
  - a client joining with a baseline inside a server batch;
  - delayed baseline and catch-up answers arriving after newer frames;
  - overlapping frames;
  - no later commit.

  In every case the renderer's store must equal a full load at its final cursor.

### 2.6 Targeted reads, and reads that cross orgs

**Inside an org,** every screen and agent read is one or a few indexed queries, never a whole-org
load (rev 2 §2.6, unchanged):

| Read | How | Cost |
|---|---|---|
| Docket list | active rows only, the point access check per row, a page limit (Appendix A.3) | rev 3's form: 0.2–1.6 ms in a dedicated database (§8); rev 4's form is measured in the prototype |
| Header counts | `count(*)` over the active partial indexes; archived and backlog totals from counter rows | |
| Per-turn prompt | only the agent's neighbourhood: its row, at most 6 ancestors, children, peers, its chain's free credits, its open questions and audiences | |
| Lineage | a recursive query over `predecessor_id` | |

**Across orgs,** a read is a fan-out: one targeted query per org database, run in parallel through
each org's pool and merged in Python. There are three such reads today.

| Read | Today | Rev 3 |
|---|---|---|
| `GET /api/accounts` (which agents are bound to which account) | loads every org's whole document and walks every agent (audit §3.4) | per org: `SELECT name, account, state FROM agents WHERE account IS NOT NULL AND NOT tombstone`, i.e. every placement, archived agents included, exactly as today's `bound` list (rev 7.3: rev 4's live-only count would have changed the accounts screen); merged with the account rows the accounts store serves (the app database's `accounts` once `registry.py` is ported, §6.3 step 3) |
| `GET /api/orgs` (the org list with summary counts) | the registry and per-org summaries | the registry from the app database, plus one summary query per org (live agents, open items, unread mail, all by partial index) |
| `list_orgs_with_docs` (bridge traffic, 5 s TTL; the public kiosk traffic is gone, decision 17) | loads every org | the registry plus the needed per-org columns |

**Cost** (measured, §8): about 0.05 ms per query once a pool connection exists, and about 17 ms per
org whose pool is cold, in parallel. With 4 orgs that is under 2 ms warm and about 20 ms cold. With
50 orgs: about 3 ms warm, about 100–200 ms cold, bounded by a fan-out concurrency of 8.

### 2.7 Background work as job rows, per org database

Each org database has `jobs(id, kind, agent_id, item_id, watchdog_id, run_at, state, attempts,
lease_owner, lease_until, last_error, dedupe_key)`. It has a partial index on queued jobs by
`run_at`, and `UNIQUE (kind, dedupe_key) WHERE state IN ('queued', 'running')`.

- **Who writes a job:** the org transaction that creates the condition. Examples:
  - a deposit to an idle agent → `deliver`;
  - a freeze → `resume` at its until-time;
  - a watchdog → its next `check`;
  - a "working" status → `checkup` at +20 min;
  - an archivable item → `archive` at its deadline;
  - a decision to run an agent → `start_turn` (§2.4);
  - a cross-org mail → `deliver_external` (below).
- **Who runs it.** Each engine process runs a scheduler per org it serves.
  - It keeps the org's next due time from `SELECT min(run_at) … WHERE state = 'queued'`, and wakes
    on that time or on `NOTIFY org_jobs` from the org database.
  - It claims due jobs with `FOR UPDATE SKIP LOCKED … ORDER BY run_at LIMIT n`, leases them, and
    runs each as its own org transaction.
  - Several processes can schedule the same org: `SKIP LOCKED` hands each job to exactly one.
- **Orgs nobody is serving** (no desktop client, no running agent) still have due jobs: a freeze
  ending, a watchdog. A slow sweep reads `min(run_at)` from every registered org: one cheap query,
  every 60 s. It starts serving an org whose next job is due within the sweep interval. Idle orgs
  therefore cost one connection-minute check, not a held connection.
- **Cross-org mail** (`@org:<slug>`) already happens in two separate writes today. The sender's org
  transaction records the outgoing row; then `supervisor.deliver_org_inbox` writes the receiver.
  Here:
  1. The sender's transaction writes the outgoing row and a `deliver_external` job, in the sender's
     database.
  2. The job inserts into the receiver's `org_inbox`, keyed by the message's global id
     (`UNIQUE (message_id)`, so a retry is a no-op).
  3. The job marks the sender's row delivered.

  This needs no shared table.
- **What jobs replace: every polling loop, in 3.2.0 (Q9).** The supervisor loops of audit §3.4:

  | Loop today | Job |
  |---|---|
  | auto-resume, every 30 s per org (decodes every agent) | `resume` at each freeze's until-time; `start_turn` from the transaction that makes an agent runnable |
  | working-cache keeper, every 20 s (abandoned docket items, idle reminders, checkup and keepalive) | `archive`, `remind` and `checkup` at their own due times, written by the transaction that sets them up |
  | watchdog engine, every 5 s | each watchdog's next `check` |
  | storage watchdog, every 20 s | none: its limits belong to the sandbox container and the kiosk spend limit, both removed from 3.2.0 (decision 17 and the sandbox removal). It goes with them; if the removals leave any storage check, it becomes a `storage_check` job that requeues itself |
  | mail drain, every 1 s or when kicked | `deliver` from the transaction that deposits the mail |
  | docket reminder scans, retries | `remind`, and a retry `run_at` on the failed job itself |

  The renderer's polling (the tree about every 6 s, the desk chat, notifications every 5 s) is
  replaced by the feed (§2.5).

  Timers that read state outside Orgtree (provider usage, update checks, the mail hub) are not
  database polling and have no due time in any org. They stay timers in the engine host, which is
  one process (§2.9). The stage that moves the loops lists every remaining timer and why it stays.

### 2.8 Domain modules

| Module | Owns |
|---|---|
| `agents` | tree and lifecycle, scope and grants, lineage |
| `docket` | items, access, list, update, reviews, archive |
| `mail` | mail, mailboxes, notices, delivery, steer records, user mail, org inbox, cross-org delivery jobs |
| `questions` | asks, credit and scope requests |
| `audiences` | grants and requests |
| `watchdogs` | dogs and their events |
| `documents` | presentations |
| `reservations` | reservations |
| `scheduling` | org jobs, the scheduler, turn tickets |
| `feed` | the change log and catch-up |
| `org` | settings, tiers, net |
| `registry` (new, app database) | org lifecycle, accounts, engine instances |
| existing provider modules | provider and usage logic |

Each module owns its tables. Others call its functions inside the same transaction, never its SQL.
The ledger's rules move into the modules. Today's behaviour suites are the contract for each move.

### 2.9 Stateless engine, several processes, large texts out of hot rows

- **No process holds org state.** Caches are allowed only when keyed by `(org, rev)` and dropped
  when that org's feed moves past them.
- **Several engine processes coordinate only through the databases:**
  - **Row locks and `SKIP LOCKED`** inside org databases.
  - **The app database** holds the turn tickets, the `engine_instances` heartbeats that leases
    refer to, and the registry state, which every process watches through `NOTIFY app_orgs`.
  - **Turn processes** (provider CLIs) are owned by the engine process that started them. Their
    ticket records the owner and lease, so no second process starts a second turn for that agent,
    and a dead owner's tickets expire.
- **Each process has its own pools** (§2.11). With P processes the connection budget is P times the
  per-process one.
- **The two processes of 3.2.0 (Q9).** Today one engine process holds the data root's owner lock
  (`claim_data_root`), serves the loopback port and runs everything. In 3.2.0:

  | | Engine host (process 1) | Worker (process 2) |
  |---|---|---|
  | Started by | the desktop or the boot host, as today | the engine host, as its child; it exits when the host exits |
  | Data root owner lock | holds it | does not take it |
  | Loopback port, HTTP, websocket, agents' tool calls | serves them | none |
  | Admin connection (Q10) | the org-lifecycle module only | never |
  | Per-org schedulers and jobs | runs them | runs them |
  | Admits and runs turns | yes | yes |
  | Timers for outside state (§2.7) | runs them | none |

  - Both processes are registered in `engine_instances` with a heartbeat. Work is shared only
    through `SKIP LOCKED` and leases.
  - If the worker dies, the host restarts it. Its leases expire, so its jobs and tickets go back
    to the queue, and the host takes them meanwhile.
  - The design allows more workers; 3.2.0 runs exactly one.
- **Large texts** (charters, descriptions, mail and document bodies, steer texts) live in one-to-one
  content tables, and provider JSON payloads in `agent_runtime`. Hot rows stay about 200 bytes.
  Transcripts stay on disk in the org's folder.

### 2.10 One database per org, and a minimal app database

**Names.** `orgtree_app` is the app database. `orgtree_org_<n>` is one database per org; `<n>` is
the registry's `org_id`, so a rename never renames a database. Today's `orgtree` database becomes
the frozen legacy store: it is not modified, and is dropped one release after conversion (§5.3).

**The app database holds exactly these tables.** For each, why it cannot live in an org's database:

| Table | Holds | Why it cannot be per-org | Org footprint |
|---|---|---|---|
| `orgs` | `org_id`, `slug` (`UNIQUE … WHERE state <> 'trashed'`, so a trashed org's name can be reused as today, and a restore picks a free name if it was), `org_uuid UNIQUE`, `database UNIQUE`, `state CHECK (provisioning, converting, active, closing, unavailable, trashed, purging)`, `unavailable_step CHECK (import, conversion, migration, identity)` (set only while `unavailable`), `state_reason` (one line for the org list), `report_path` (the full report under `<data>/conversion/`), `attempts`, `attempted_build`, `state_at`, `created_at`, `trashed_at` | The engine must find an org's database before it can open it. A row inside the org's own database cannot answer "which database is org X". | one row |
| `accounts` | machine-wide accounts only (rev 4, finding f7): `id` (the stable account slug), `provider`, `harness`, `label`, `credential_kind`, `credential_ref` (a path or token-store reference, never key material), `mode`, `enabled`, `auth`, `identity json` (the provider's account description, shapeless, Q1), `removing`, `tint_ordinal`, `created_at`, `registered_from`, `extra`; plus `account_marks(account_id, pool, until, window, observed_at, provenance)`, `account_spend(account_id, usd_total, turns, since, updated_at)`, `account_aliases(alias, account_id)`, `account_counters(provider, next_id, next_tint)` (ids and tints are never reused, `registry.py`) | `registry.py` defines these accounts as "machine-global, every provider together". One account serves agents in every org. A limit mark set by a turn in org A must stop turns in org B, and spend is metered machine-wide. Today this is `accounts-registry.json`; it moves here so several processes can update marks and spend in transactions. **Accounts restricted to one org (`origin_org`) are not machine-wide**: `registry.py:43–46, 285–293, 500–524` makes them bindable only in that org, so they move into that org's database (`org_accounts`, `org_account_marks`, `org_account_spend`), with no trace here. | none |
| `turn_tickets`, `turn_admission` | the machine-wide fair queue (§2.4) | the slot limit and round-robin fairness are defined across orgs | transient tickets (`ON DELETE CASCADE`) |
| `engine_instances` | `id`, `host`, `pid`, `started_at`, `heartbeat_at` | a process is not owned by any org; leases in every database refer to it | none |
| `schema_migrations` | the app database's own migrations | bookkeeping | none |
| `app_settings` | one row: `accounts_version`, `apikey_cutover_at` (from `accounts-registry.json`), `legacy_cutover` (the one-time conversion marker, §5.2) | machine-level facts with no org | none |

**Deliberately not in the app database:**

| What | Why not |
|---|---|
| Provider usage readouts | caches of provider answers, kept in memory as today; not data that must exist |
| Cross-org mail routing | the sender's and receiver's databases plus an idempotent job (§2.7) are enough |
| Operation receipts | move into each org's database. Org creation and deletion are idempotent by slug and registry state |
| `app-settings.json` | stays a file. It is written rarely, by the UI, and read on change |
| Credentials | stay in their profile folders, never in a database |
| The mail hub's store | separate infrastructure, unchanged |
| `chat-window-index.sqlite3` | stays a per-machine cache (it is rebuildable). Its keys include the org's `org_uuid`, so a purged or re-imported org can never read another's cache |
| `reply-events.sqlite3`, `file-deliveries.db` | **move into each org's database**: they are org-owned durable records keyed by org and agent, and decision 11 makes an org one body of data. A delivery receipt with no evidence of its org stays in the kept old file, untouched (decision 18, option X; §5.2) |

**An org's whole body** is therefore its database plus its folder (workspace and scratch,
including transcripts). Its registry row and live tickets are the only traces in the app database,
and the org lifecycle removes them in the same step (§2.13). Its org-restricted accounts, with their
marks and spend, are part of its database (rev 4, f7).

**Account ids across the two places.**
- Ids for both kinds are minted from `account_counters`, so they never collide on this machine.
- Binding resolution checks the org's own `org_accounts` first, then the machine-wide `accounts`.
  That matches today's rule that an org-key account is bindable only in its origin org.
- On import, an org-key account whose id is already used here is re-keyed. The org's bindings are
  rewritten, and the import report lists the change (§2.13).

### 2.11 Connections

**Measured** on my dev cluster (§8):

| Fact | Value |
|---|---|
| Opening a connection, first query included | 16.7 ms median |
| An idle backend | 4.2 MB private memory (19.8 MB working set, mostly shared pages) |
| `max_connections` | 40, on both my cluster and the live one (`instance.json`) |

**Pools.** One small pool per org database per engine process, opened lazily on the org's first use
and closed after 10 idle minutes:

- 0 connections while idle;
- 1 kept while serving;
- at most 4.

Plus one `LISTEN` connection per org the process actively serves (§2.5), and one pool plus one
listener for the app database.

**Budget:**

| Situation | Connections |
|---|---|
| Today's 4 orgs, all active, one process | about 4 × (1 listener + 1–2 pooled) + 2 for the app database = 10–14 |
| A heavy day: 10 active orgs, 2 processes | up to 2 × (10 × 3 + 2) = 64, which needs `max_connections` raised |

An idle org costs nothing. With 3.2.0's two processes (§2.9), today's 4 orgs use about 20–28.

**The runtime's registry module (rev 7.3, built in stage 1-B).** `orgdb.registry` is what engine
code uses to reach orgs, as the runtime role:

- `rows()` (every registry row, any state), `lookup(slug)`, `exists(slug)`, `active()` and
  `active_slugs()`, over one shared connection to the app database;
- `connection(slug)`: a pooled connection to that org's own database. The first connection to a
  database checks its `org_identity` against the registry row, so a database that is not this
  org's is never used;
- `lifecycle()`: the process's lifecycle handle (the only holder of the admin connection);
- `retry(org_id)`: Retry of an unavailable org, by the step it failed at (§2.13).

As built for the one-process prototype, the pool keeps at most 2 idle connections per database
and 16 in all, and a connection idle for 10 minutes is closed at the next checkout or release
(no sweeper thread). The cap of 4 per database and the per-process queue come with the worker
process (§6.3 step 8). Retry closes the org's idle connections, since its fence ended their
sessions.

**`max_connections` is 100 (Q11, decided).** The custodian writes it into the cluster settings it
owns, for fresh installs and on upgrade. Memory cost: about 4 MB private per backend, so 0.4 GB at
the full 100. The engine enforces a global per-process cap and queues requests for a connection
rather than failing.

**The admin connection (Q10, decided).** Creating, renaming and dropping databases needs the
cluster's admin role; the runtime role cannot do it.

- The engine host opens the admin connection and gives it only to the org-lifecycle module.
- That module does create, trash and restore (rename), purge (drop), import (restore), the
  conversion's database creation, and the migrations of the app and org databases.
- No other module, and never the worker process, holds it.
- A source scan test fails if any other module reads the admin URL or opens that connection.

### 2.12 Migrations, once per database

- **The app database** has its own migration folder (`pg_migrations/app/`), applied by
  `pgstore.migrate` at start exactly as today: one transaction per file, an advisory lock, and drift
  refusal.
- **Every org database** has the org migration folder (`pg_migrations/org/`). Each org database
  records its own `schema_migrations`.
  - At start, the engine migrates every registered `active` org, one org at a time, each file in
    its own transaction under that org's advisory lock.
  - An org created later is born at the current level.
  - An org whose migration fails becomes `unavailable` (step `migration`), with the reason, and the
    other orgs start (the Q12 rule, applied to migrations too). The failed file rolled back, so
    its database stays exactly at its last good level. It is retried as in §2.13.
  - A failure of the **app** database's migrations still refuses the start: no org can run without
    it.
- **A partly migrated set is safe by construction.** Every org database is always at exactly one
  migration level: each file commits in its own transaction, and its row in `schema_migrations`
  commits with it. So a crash between orgs leaves some orgs at N+1 and others at N, and the next
  start finishes the rest. The engine never serves an org whose level differs from the one it
  expects:

  | Org's level | What the engine does |
  |---|---|
  | lower than expected | migrates it before serving |
  | higher than the engine knows (a newer build ran) | does not serve it: `unavailable` (step `migration`, "written by a newer Orgtree"), with the other orgs starting. The app database at a newer level still refuses the start (`MigrationDrift`, as today) |

### 2.13 The org lifecycle, end to end

**Rules for every lifecycle operation (rev 4, finding f6).** Rev 3 let the registry state alone
stand for an operation. Two requests from the same host (two Retry clicks, or a Retry racing a
trash) could then run the same steps. A failure cleanup could drop a database that another request
had already made active. And a `NOTIFY` was treated as if it proved that work had stopped. Rev 4:

1. **One operation at a time per org, claimed in the registry.**
   - The `orgs` row carries `op_kind CHECK (create, convert, retry, trash, restore, purge, export,
     import)`, `op_epoch`, `op_owner` → engine_instances, `op_step`, `op_target_db` and
     `op_started_at`.
   - A claim is a compare-and-set: `UPDATE orgs SET op_kind = …, op_epoch = op_epoch + 1, op_owner
     = …, op_step = 'claimed' WHERE org_id = $1 AND (op_kind IS NULL OR <its owner is dead>)
     RETURNING op_epoch`.
   - Every later transition matches `(org_id, op_epoch)`.
   - A second request finds the claim and is answered "busy".
2. **Each step is recorded, and every step is idempotent.**
   - `op_step` names the last step completed.
   - The engine host is the only owner. After a crash, the next host takes over every claim left
     behind, and resumes it from `op_step`.
3. **Work happens in a staging database named by the attempt.**
   - A create, conversion, retry or import builds `orgtree_stage_<n>_<epoch>`, recorded in
     `op_target_db`.
   - Only after verification does the same claim rename it to its final name.
   - Cleanup drops only the database named in its own claim, and never the database the row
     names as current. A stale cleanup can therefore never drop a verified active database.
4. **Published last.**
   - A row becomes `active` only after every prerequisite exists: the database under its final
     name, `org_identity`, settings, runtime grants and the org's folder.
   - `NOTIFY app_orgs` comes with that last transaction.
5. **Quiescence before anything moves or disappears (rev 5).** Two fences, used in this order:
   1. *Close admission.* Compare-and-set the row to `closing`. Every process refuses new work for
      the org: the API, the schedulers and the sweep check the registry state. They learn of the
      change by `NOTIFY`, and they re-read the state whenever a connection to the org fails.
   2. *The runtime fence.*
      - Every org database is created with `REVOKE ALL … FROM PUBLIC`. The runtime role, which
        neither owns it nor is a superuser, gets `CONNECT` explicitly.
      - The fence is `REVOKE CONNECT ON DATABASE … FROM orgtree_runtime`, then `pg_terminate_backend`
        on every backend of that role connected to it.
      - No engine process can keep or open a connection to the org any more, including one that
        missed every notice. The lifecycle module's admin connection still can.
   3. *Drain, through the admin connection.*
      - Cancel the org's turns (§2.4 step 3): the org-side request rows through the admin
        connection, the tickets in the app database.
      - Each owner stops its provider and acknowledges. An owner that does not is terminated by the
        host (§2.4 step 6).
      - Besides the engine, provider processes are the only writers of the org's folder, so once
        they are gone the folder is still.
   4. *The final fence, only for a rename or a drop* (trash, purge, the replaced database of an
      import): `ALTER DATABASE … ALLOW_CONNECTIONS false`, then terminate every remaining
      backend. A rename or a drop needs no connection to the database itself.

   An export uses fences 1–3 only (below). Reopening runs any identity rewrite first, then grants
   `CONNECT` back to the runtime role (and allows connections again where fence 4 was used). Only
   then does it publish `active`.

**Create** (≈1 s; measured: `CREATE DATABASE` 0.63 s, plus the schema):

1. One app transaction: insert the row as `provisioning` (`UNIQUE (slug)`), and claim it
   (`create`).
2. `CREATE DATABASE orgtree_stage_<n>_<epoch>`, through the admin connection that only this module
   holds (Q10, §2.11), then `REVOKE ALL … FROM PUBLIC`. The runtime role gets `CONNECT` only at
   step 5.
3. Apply the org migrations, then `org_identity(org_uuid, slug, incarnation)`, default settings and
   runtime grants.
4. Create the org's folder.
5. Rename the database to `orgtree_org_<n>`, grant `CONNECT` to the runtime role, then set
   `active` and send `NOTIFY`, which releases the claim.

**Trash (reversible, as today).**

1. Claim the org.
2. Quiescence (rule 5), with the final fence.
3. Move the folder to `<data>/deleted/<slug>-<stamp>/`.
4. Rename the database to `orgtree_trash_<n>_<stamp>`. It stays fenced while trashed.
5. Set the row `trashed`.

The slug is then free for a new org, as today.

**Restore.**

1. Claim the org (`restore`).
2. Rename the database back and move the folder back. `op_step` records each.
3. If the slug has been reused meanwhile, pick a free one. Then, through the admin connection,
   rewrite `org_identity.slug` and check `org_identity` against the registry row. The admin can
   connect because `ALLOW_CONNECTIONS` is turned back on, while the runtime still has no
   `CONNECT`.
4. Grant `CONNECT` to the runtime role, then set `active`.

A crash at any step resumes from `op_step`. The runtime can reach the org only after step 3's
check.

**Purge** (empty the trash), only from `trashed`:

1. Claim the org.
2. `DROP DATABASE` on the name recorded in the claim (0.26 s, measured).
3. Remove the trash folder.
4. Delete the registry row; its tickets cascade.

Nothing of the org remains. The one-time conversion marker (§5.2) means the retained legacy copy is
never converted again.

**Export (rev 4, finding f10; corrected in rev 5).**

1. Claim the org, then fences 1–3 of rule 5:
   - admission is closed;
   - the runtime is fenced off the database;
   - the org's turns are drained.

   Nothing that writes the org can touch its database or its folder now: no engine process, no
   provider. The org is unavailable for the dump plus the folder copy, about 3–10 s for the
   largest org (inferred; the dump alone measured 2.2 s).
2. The lifecycle module opens the **snapshot keeper**: one admin connection in a `REPEATABLE READ`
   transaction that calls `pg_export_snapshot()` and stays open until the dump has finished.
   - `pg_dump -Fc --snapshot=<it>` connects as the admin role, which the runtime fence does not
     block.
   - The manifest's per-table counts and checksums are read through the keeper, in the same
     snapshot.
   - The manifest also carries `org_uuid`, `incarnation`, slug and schema level, and the ids of the
     machine-wide accounts its agents are bound to.
3. Copy the folder with a file manifest (path, size, sha256). Nothing can change it while the
   runtime is fenced and the providers are stopped.
4. Verify the package against both manifests. Only then is the export complete.
5. Close the keeper, grant `CONNECT` back to the runtime role, and set the row back to `active`. On
   a failure the same reopening runs, and the partial package is deleted.

The existing human-readable `export_json` stays, built from queries.

**Import / move (rev 4, finding f10).**

1. Verify the package's files against its file manifest.
2. Decide the identity.
   - If the `org_uuid` is not registered, keep it. If it is, refuse unless the user asked for a
     clone, which gets a new `org_uuid`.
   - If the slug is taken here, the org gets a free slug, as a clone always does.
3. Claim, then restore into `orgtree_stage_<n>_<epoch>` (5.7 s measured for the live org).
4. **Verify the source before changing anything.** Compare counts and checksums with the source
   manifest at the source's schema level, and `org_identity` with the manifest.
5. **Then migrate forward** if the source is older; refuse it if it is newer. Check the target's
   invariants: FKs and CHECKs hold, and tables no migration touched keep their counts.
6. **Rewrite the identity explicitly, before anything can use the database.**
   - Through the admin connection (the runtime has no `CONNECT` on a staging database), set
     `org_identity` to the registry row's `org_uuid` (new for a clone) and slug (new when it was
     taken), with a new `incarnation`.
   - Then compare it with the registry row.
   - So no client cursor from another copy is accepted (§2.5). The runtime gets `CONNECT` only at
     step 8.
7. **Accounts.**
   - The org's own accounts arrive inside its database (f7). One whose id is already used on this
     machine is re-keyed, and the org's bindings are rewritten.
   - Bindings to machine-wide accounts that do not exist here are reported. Those agents fall back
     by the existing rules, and nothing is silently rebound.
8. Restore the folder from the verified package, rename the database to its final name, grant
   `CONNECT` to the runtime role, then set `active`.

**Tests (§9):**

- two concurrent Retries: one wins, the other is answered "busy";
- a stale cleanup after a successful retry never drops the active database;
- a crash at every step of create, trash, restore, purge and import, finished by the next start;
- a paused worker and a running provider during trash and purge;
- restore under a reused slug, with the identity rewritten and checked before the runtime
  reconnects;
- the org-side cancellation writes under the runtime fence;
- export:
  - the real `pg_dump` and manifest under the runtime fence;
  - a writer that missed every notice, trying an existing connection and a new one (both
    refused);
  - an artifact writer;
  - a failure and its reopening;
  - an import of the verified package;
- import from an older schema through a migration that changes rows;
- a clone of an already registered `org_uuid`, and an import whose slug is taken;
- imported account-id collisions.

**Unavailable, and retry (Q12).** An org becomes `unavailable` when one of four steps fails for it:

| Step | What failed |
|---|---|
| `import` | the 2.1.14 first-launch import held it back (§5.1) |
| `conversion` | converting or reading it back (§5.2) |
| `migration` | an org migration, or its database is newer than the build (§2.12) |
| `identity` | its `org_identity` does not match its registry row |

What happens then:

- **Its old data stays untouched.** A failed conversion drops only the half-built new database. The
  legacy schema and the old files are never written. A failed migration rolls back its file.
- **The other orgs start and run normally.**
- **What the user sees.** The org list shows the org as unavailable, with the one-line reason and
  a **Retry** action. The full report (org, step, kind, record, field, both values) is in
  `<data>/conversion/<time>-<pid>/`, and the org list links to it. Nothing else opens the org.
- **Its traces elsewhere.**
  - Its turn tickets are cancelled. After verified death of their provider tree, they may be
    `lost` instead: their app recovery fence is durable, no longer holds machine capacity,
    and refuses all admission and old run identities until the org requests commit `lost`
    with raised epochs. Retry becoming `active` cannot lift this fence; the host heartbeat
    reconciles the now-openable org and lifts it only after the org commit (§2.4 step 6).
  - Mail sent to it from another org waits in the sender's outbox as a `deliver_external` job that
    backs off (1 minute, doubling, at most 1 hour) until the org is `active`.
  - `/api/accounts` and `/api/orgs` list it as unavailable instead of counting its agents.
- **Retry** claims the org (`retry`, rule 1, so two Retry clicks cannot both run) and runs the
  failed step again for that org alone, in a staging database (rule 3), from the untouched old
  data:
  - `import`: the per-org import from `pre-postgres/orgs/<slug>.db`, then the conversion;
  - `conversion`: the conversion from the legacy schema;
  - `migration`: the pending migrations;
  - `identity`: the check again.

  If it succeeds, the org becomes `active` and starts. If not, it stays unavailable with the new
  reason, and `attempts` goes up by one.
- **When retry runs.** It runs when the user asks. It also runs once automatically when a
  different build starts (`attempted_build` differs), because the new build may contain the fix.
  It does not run at every restart.
- **What 3.2.0 does not offer** for an unavailable org: trash and purge. Its data is not in the new
  layout yet.

## 3. The schema

### 3.0 Conventions

These are rev 2's conventions, with one change: **no table in an org database carries `org_id`**,
because the database is the org.

- **Keys.** Every record table has a surrogate key, `id bigint GENERATED ALWAYS AS IDENTITY`. Visible
  names stay unique natural keys: agent `name` (today's node id), item `slug`, mail `public_id`.
  Renaming an agent is one `UPDATE agents SET name` (Q6).
- **Timestamps (rev 4, finding f12)** are `timestamptz` at PostgreSQL's native microsecond
  precision. Rev 3 said "kept to the millisecond". That would change valid legacy instants:
  `restart_wake.py:39–40, 350` stores `datetime.now(timezone.utc).isoformat()`, which has
  microseconds and a `+00:00` offset.
  - A timestamp whose stored text is not today's canonical form (`YYYY-MM-DDTHH:MM:SS.mmmZ`) also
    keeps that text in a sibling `<field>_text` column, so the round trip and the API output are
    exact.
  - An unparseable value keeps its text in `extra` and is reported (Q2).
  - Millisecond formatting is only how canonical values are displayed.
  - Tests: millisecond stamps; microsecond stamps with an offset; pre-epoch values; two records
    inside one millisecond keep their order.
- **Numbers.** `bigint`/`integer` for integers, `double precision` for floats, and `numeric` where
  stored values mix the two. For example, `grant` holds 1,198 ints and 10 floats on the live copy.
- **Absent versus null.** A `<field>_null` boolean marks a present null for the fields stored both
  ways on real data. For JSON columns, SQL `NULL` means absent and JSON `null` means null.
- **Strings containing U+0000 or a lone UTF-16 surrogate** go to the record's `extra` JSON, and the
  conversion report counts them. PostgreSQL text holds neither, and a lone surrogate cannot even be
  encoded as UTF-8. The 2026-10-02 live copy has none: the 17 rows whose text shows `\u0000` hold
  those six characters, not the character (measured 2026-10-03). A json column keeps both as
  escapes, but no json or jsonb operator accepts them, so keys computed from JSON (org migration
  0008) read it through `orgtree.json_readable`, which reads each as U+FFFD.
- **`extra json`** holds unknown top-level keys and is expected to be empty. **`row_version`** is on
  every mutable row.
- **Principals.** `<role>_kind CHECK (agent, user, engine, outside)` + `<role>_id` → agents +
  `<role>_ref` (outside address).
- **Deleting an agent** erases its own records and keeps a tombstone row (`state = 'deleted'`) for
  historical references (Q6).
- **Agent identity (rev 6, finding f17).** Revs 4 and 5 modelled a persistent "seat" keyed by
  the legacy mint id `seat_id` (`born`), with one head per seat. That is wrong for today's data:
  - **A generation advance makes a new agent.** Cheap compaction, a model switch, compaction split
    and reseed all keep the agent's node id `x`, and copy the old session into a new node
    `x@gen` that keeps the same `seat_id` (ledger.py:5505–5541).
    - That copy is a **separately addressable** agent. Its first deposit mints its own mailbox
      identity and sequence, while `x` keeps its own (3027–3047).
  - **Two live agents can share one `seat_id`.**
    - A knowledge bearer such as `x@0` can be rehired, even by `x` itself, as a subordinate
      (5721–5729).
    - Then both are live, with the same `seat_id` but different names, parents, mailboxes, turns
      and ownership (5873–5877, 5947–5949).
    - Backfill shares the lineage id on purpose (751–769), and
      `tests/test_principal_identity.py:370–389` asserts it.

  So `seat_id` is a **lineage token**, not an identity. Rev 6:

  - **`agents` has one row per legacy node**: every independently addressable agent, `x` and each
    `x@gen`, live or archived.
    - `name` is the node id, unique among rows that are not deleted.
    - `lineage_born` keeps the legacy `seat_id` exactly. It is shared by a lineage, indexed, **not
      unique**, and never rewritten.
    - `generation` is that node's own counter.
    - `predecessor_id` and `successor_id` link a lineage's nodes.
    - There is no seat table and no "head".
  - **Each row is its own principal**, with its own mailbox (Appendix A.4, `mailboxes(agent_id PK,
    next_recv_seq)`), parent, state, account bindings, turns and ownership.
    - A compaction of `x` keeps `x`'s row (its id, mailbox and assignments). It adds a new row for
      the archived session, copying fields and stripping mailbox authority, as today.
    - A rehire makes the bearer's own row live again. It never merges into `x`.

  References come in two classes:

  | Class | Meaning | Examples | Columns |
  |---|---|---|---|
  | **current holder** | who has it now; never binds to a namesake | docket owner and reviewer (plus their recorded names, for authorization, A.3), holders; mailbox owner; mail recipient; question asker and target; audience grantee and grantor; watchdog owner; reservation holder | `<role>_agent_id` → agents (that node's row), plus what the legacy record stored with it (`<role>_generation`, `<role>_born`, `<role>_deleted`), for an exact round trip and today's continuity states |
  | **historical** | who did something then; never re-resolved | creator, last updater, history and event actors, mail senders, delivery batches, steer records, document authors, op receipts, turn logs | the principal kind plus the name and generation exactly as recorded, as typed columns with no foreign key: a name recorded long ago does not prove which row it meant |

  **Converting a current-holder reference** `{node, generation, born, deleted}` follows today's
  continuity rule (`_work_identity_state`, ledger.py:13680–13739). It is applied to the row that
  now carries the name `node`:
  1. Marked `deleted`, or no row carries that name: a tombstone row (state `deleted`, that name,
     that `born`).
  2. With `born`: that row, if its `lineage_born` equals `born`. Otherwise the reference names a
     different agent that once wore the name, so a tombstone row.
  3. Without `born`: that row, if its `generation` is at or above the stored one. Otherwise a
     tombstone row.

  A tombstone is never a live namesake, so a stale reference stays stale, as today. The stored
  values round-trip exactly, so `_work_identity_state` gives the same answer before and after,
  and that is a test.

  **Applied to Appendix A.4–A.6.**
  - The current-holder columns, each `→ agents`: the mailbox (`mailboxes.agent_id`), mail
    `recipient`, `notices`, `asks` (the asker), `audience_grants` (grantee and grantor),
    `watchdogs.owner`, `reservations.owner`.
  - The historical ones: the mail sender, `delivery_batches`, `steer_records`, the author of
    `documents`, `events` and `event_agents`, and `op_receipts` (with `gen`).
  - The implementation lists every remaining role column in the same table before stage 1
    lands, and the round-trip tests cover each one.

  **Tests (§9):**
  - a head and its rehired predecessor both live, with different parents and account bindings,
    independent mailbox ids and `recv_seq`, deposits to both, and separately owned docket items;
  - retiring or deleting either while the other survives, then compacting or rehiring the bearer;
  - compaction and an account change with an open owned item; retire and rehire; rename;
  - delete, then a same-name hire;
  - legacy holders with and without `born`;
  - semantic behaviour and the independent verifier's values (§5.4), not only row counts;
  - a mutant that collapses a head and its live bearer into one principal, which must fail a
    test.
- **`org_identity(org_uuid, slug, incarnation)`** is a one-row table. The engine checks it against
  the registry on every pool open. `incarnation` is minted when the database is created and again
  when another database replaces it (§2.5, §2.13).
- **A dedicated `orgtree` schema in every database (rev 4, finding f14, Q7 as ruled).** Every app
  and org table lives in schema `orgtree`, never in `public`.
  - Migrations create and qualify `orgtree.<table>`.
  - The runtime role gets `USAGE` on schema `orgtree`, plus the table rights it needs, and has
    `search_path = orgtree` set on the role in each database.
  - `CREATE` on `public` is revoked in every Orgtree database.

  Rev 3.1 had said that one database per org turns the schema ruling into "dedicated databases".
  That was a reinterpretation without a ruling, and rev 4 withdraws it.

### 3.1 The app database

| Table | Columns | Notes |
|---|---|---|
| `orgs` | as §2.10 | `NOTIFY app_orgs` on every change |
| `accounts` | as §2.10: machine-wide accounts only | |
| `account_marks` | as §2.10 | PK `(account_id, pool)` |
| `account_spend` | as §2.10 | PK `account_id` |
| `account_aliases`, `account_counters`, `app_settings` | as §2.10 | |
| `turn_tickets` | `id`, `request_id UNIQUE`, `org_id` → orgs `ON DELETE CASCADE`, `agent_id` (the org database's key), `agent_name` (for display), `lane`, `enqueued_at`, `state CHECK (waiting, running, stopping, done, cancelled, lost)`, `claim_epoch`, `lease_owner` → engine_instances, `started_at`, `ended_at` (rev 5, f2) | `UNIQUE (request_id)`; `UNIQUE (org_id, agent_id) WHERE state IN ('waiting', 'running', 'stopping')`; partial index on waiting by `(org_id, enqueued_at)`; index `(lease_owner) WHERE state IN ('running', 'stopping')` |
| `turn_admission` | `singleton`, `slot_limit` (today's setting, default 16), `last_org_id` | |
| `engine_instances` | `id`, `host`, `pid`, `started_at`, `heartbeat_at` | |
| `schema_migrations` | | |

### 3.2–3.8 The org database

Every table of rev 2 §3.1–§3.8 moves into each org database **without its `org_id` column**: agents
and their cold, child and link tables; the docket; mail, notices and delivery; questions; audiences;
watchdogs; documents; reservations; events and receipts; jobs; and `changes`. Every index loses its
`(org_id, …)` prefix, and every composite foreign key becomes a plain one.

Rev 2's per-org settings table (`org_settings`, plus the lists `org_dirs`, `org_tiers` …) becomes
the org database's settings tables, unchanged apart from the key.

Additions:

| Table | Contents |
|---|---|
| `org_identity` | §3.0 |
| `org_revision(rev)` | §2.5 |
| `op_receipts` | today's `public.receipts` rows for this org, plus today's `op_receipts` log |
| `reply_events(agent_id, generation, id, text, scope)` | today's `reply-events.sqlite3` rows for this org |
| `file_deliveries(id, agent_id, fingerprint, result)` | today's `file-deliveries.db` rows for this org |
| `conversion_runs` | §5.2 |
| `org_accounts`, `org_account_marks`, `org_account_spend` | the accounts restricted to this org (rev 4, f7); same columns as the app tables |
| `org_extra(key PK, val json)` | a top-level section outside the engine's key registry, kept exactly (rev 4, §5.2) |
| `turn_requests` | durable turn identities (rev 4, f2; §2.4) |
| `org_topology` | the one-row topology lock (rev 4, f1; §2.2) |
| `docket_counters` | the desktop's archived and backlog totals (rev 4, f13; A.3) |

Appendix A gives the full detail: the tables, column groups, indexes, child and link tables, the
measured reasons (the turns table, the tool lists, the access rule) and the deliberate duplicates.
It is rev 2 §3.2–§3.10 with `org_id` removed.

### 3.9 What is removed

None of these exists in the new databases. The legacy database keeps all of them, untouched,
until the cleanup release (Q3):

- the 18 per-row triggers and their side tables;
- the JSON expression indexes;
- `json_extract`;
- `public.receipts`;
- the per-org schema creator chain (`orgtree_create_org_schema` and its 14 wrappers);
- the org markers in `orgs/`. The registry is the only record of which orgs exist. 3.2.0 reads the
  markers once, in the converter's first pass (§5.2), and **never changes or removes them** (rev
  4.1, decision 14). If they disappeared, the old build's startup would retire every org it no
  longer finds a marker for (`retire_unmarked`), and a rollback would not work. The cleanup release
  removes them with the legacy database.

The legacy `orgtree` database stays untouched for one release (Q3), then is dropped.

## 4. How today's code maps onto the target

| Today | Rev 3 |
|---|---|
| `store` / `pgstore`: one database, org schemas, `LazyDoc`, compare-on-save | `db.org_pool(org)` (§2.11), `OrgTx`, domain modules. During the transition, a compatibility view (the rev 1 mappers, §6.2) presents the old dictionary over one org's database for code not yet moved. |
| `orgtx.org_tx` lock plans | `OrgTx` row locks inside the org database |
| `ledger.Org` methods (≈400) | domain functions over rows. Audit §3.3 is the checklist. |
| Supervisor loops (30 s, 20 s, 5 s, 1 s) | per-org jobs + scheduler (§2.7) |
| `turnslots.FairSlots` (memory) | `turn_tickets` in the app database (§2.4) |
| `api._sync_revs`, `hub_changed`, whole-tree refetch, renderer polling | per-org `changes` + `NOTIFY`; frames carry the changed records; catch-up (§2.5) |
| `registry.py` + `accounts-registry.json` | the machine-wide `accounts` tables in the app database, and each org's own `org_accounts` (§2.10, rev 4 f7) |
| `reply_events.py`, `filedelivery.py` side SQLite files | tables in each org database |
| `pgfeed.RevisionFeed` (one listener) | one listener per actively served org + one for the app database |
| `store.create_org` / `delete_org` / markers / `pgstore.revive_marked` | the registry lifecycle (§2.13) |
| `GET /api/accounts`, `GET /api/orgs`, `list_orgs_with_docs` whole-org loads | fan-out queries (§2.6) |

## 5. Converting existing data: one data migration

### 5.1 One path for every starting version

**Three named starting points (decision 14).** Each has its own tested path into 3.2.0:

| Starting point | What the user has | Route into 3.2.0 |
|---|---|---|
| **2.1.14** | SQLite files in `orgs/` | The first-launch import (`tools/pypg/pgimport.py`, driven by `pg_process.convert_existing_root`) creates a **new** legacy database: it applies the legacy migration chain 0001–0020 and writes the SQLite rows into the legacy layout, with its counts and checksums. The SQLite files move unchanged to `pre-postgres/orgs`. Then the converter runs. |
| **3.0.9** | one PostgreSQL database `orgtree` at migration level 0019 | The converter reads the legacy database **as 3.0.9 left it**. Nothing migrates it. |
| **3.1.0** | the same database at level 0020 | The same: read as 3.1.0 left it. |

**3.2.0 never migrates an existing legacy database (rev 4.1).**

- Rev 4 said 3.2.0 would first bring the legacy database up to 0020, "as every release has".
  Decision 14 requires the old build to keep running on its untouched data.
- Our engine refuses a database that holds a migration it does not know (`MigrationDrift`). So a
  3.0.9 database migrated to 0020 would no longer start under 3.0.9.
- 3.2.0's database bracket therefore runs the app and org migrations only. It never runs the
  legacy chain on an existing `orgtree` database.
- **Measured:** today's loader reads both levels with zero writes:
  - the live 3.0.9 copy at 0019 (`livecopy`);
  - the 3.1.0-level copy at 0020 (`lc310`, made below);
  - and the 0020-level imports of the 2.x data.

  See §5.4.

**3.0.0 to 3.0.8 are the 3.0.9 starting point (measured, decision 14 point 1).**

- Every tag from v3.0.0 to v3.0.9 ships the same 19 migration files, 0001–0019. The git blob ids
  are identical, so the bytes are too. Tag v3.1.0 adds only 0020.
- `pgstore._sha` checksums each file in its LF form, so checkouts with different line endings
  record the same values.
- Every 3.0.x engine applies all 19 files at its first start. So every 3.0.0–3.0.8 database has
  exactly 3.0.9's migration level, objects and recorded checksums: its schema is identical to the
  3.0.9 starting point.
- The live copy's 19 recorded checksums match the files of v3.0.0, v3.0.9 and v3.1.0 (19 of 19
  each).
- What differs between 3.0.x releases is only the code that writes rows. The converter reads rows
  through today's loader, which already reads every older shape, down to 2.1.12's.
- This comparison is recorded as evidence on the item, and a repo test keeps it true (§9).

**Which version wrote the live copy (measured).**

- The installed app is 3.0.9 (`resources/build-info.json`: commit `f657e06`).
- Its update log reports "latest version: 3.0.9" at every check from 2026-10-01 16:58Z to
  2026-10-02 10:58Z. The dump was taken at 11:38Z.
- The copy's `schema_migrations` show 0001–0017 applied on 2026-09-29 (the first-launch import of a
  pre-release build) and 0018–0019 on 2026-09-30. That is the 3.0.x level.

So `livecopy` is real 3.0.9 data.

**One change to the first-launch import, for Q12.** Today it is all or nothing:

- one refused org refuses the whole dry run;
- the cutover requires every org;
- the engine does not start, and the user is told to reinstall 2.1.14.

In 3.2.0 it holds back only the failing org:

1. The dry run's refusals are already per org (`<slug>: …`). An org with a refusal is held back;
   the others are imported (`import_root(only=…)` exists today).
2. The cutover record lists each held-back org with its reason. The cutover still moves every old
   file, held back or not, unchanged, to `pre-postgres/orgs`.
3. The converter registers each held-back org as `unavailable` (step `import`).
4. Retry imports that one file and then converts it. On success, the legacy database gains that
   org's schema; nothing already in it changes.

A failure that is not about one org still refuses the start, with today's message: the database
will not start, the importer is missing, the root is wrong.

### 5.2 The converter

It runs at engine start, after the app database's migrations, and before anything serves.

**One first pass, then never again (rev 4, finding f3).** Rev 3 converted "every legacy org not yet
`active`". The legacy data is kept for a release, so a converted org that was later trashed (not
`active`) or purged (no row at all) would have been converted again from the old snapshot. That
would undo a deletion. Rev 4:

1. **The first pass runs only while `app_settings.legacy_cutover` is unset.** It is the only time
   the converter scans the legacy database.
2. **It classifies every org in the legacy `public.orgs` on that first pass:**

   | Legacy state | How it is recognised today | Converted as |
   |---|---|---|
   | active | `deleted_at IS NULL`, marker in `orgs/` | `active` (or `unavailable` if it fails) |
   | trashed | `deleted_at` set by `retire_deleted`, slug `<slug>@deleted-<id>`, marker in the trash | `trashed`: its database is created as `orgtree_trash_<n>_<stamp>`, with the original slug and trash time kept, so restore keeps working (pgstore.py:646–677 keeps such schemas today) |
   | orphaned | `@unmarked-<id>` from `retire_unmarked`: no marker anywhere | not converted; listed in the cutover record with its legacy id; its schema stays in the legacy database |
   | a duplicate marker | today's `refuse_duplicate` case | `unavailable`, naming both |

3. **Every converted org's registry row records its `legacy_source`**: the legacy database and
   `org_id`, or, for an org the 2.1.14 import held back, its file in `pre-postgres/orgs`.
4. **The pass ends by writing `legacy_cutover`**: the legacy database, its migration level, the
   build, the time and the report folder. From then on the converter acts only on an explicit
   Retry of an `unavailable` org, using that row's `legacy_source` (§2.13).
5. **A crash during the first pass** leaves the marker unset, so the next start resumes the pass:
   - rows that are `active`, `trashed` or `unavailable` are skipped;
   - a claimed `convert` is redone in a new staging database (§2.13 rule 3);
   - orgs without a row are converted.

   Nothing serves before the marker is written, so no trash or purge can happen during the pass.

So a converted org that is later trashed or purged is never converted again. The tests (§9) are:

- a first pass over a legacy trashed org;
- convert, trash, restart;
- convert, purge, restart;
- a crash part-way through the first pass.

**Its input cannot change while it reads (rev 4, prep finding).**

- **The data root's owner lock.** The engine host takes it (`claim_data_root`) before the first
  pass. Every writer of the legacy data needs it: a 3.x engine, the 2.1.14 first-launch import,
  another 3.2.0 host. So the legacy database, `accounts-registry.json`, `reply-events.sqlite3` and
  `file-deliveries.db` cannot change during conversion.
- **A pinned snapshot.** Today's loader reads an org in several separate transactions (its lazy
  sections load on demand). The converter pins one read-only `REPEATABLE READ` connection for the
  org, the way an org transaction pins its connection today. Every lazy read of that org then
  shares one snapshot.
- **Measured** (`probe/legacy_load.py`, §5.4):
  - On a read-only clone of each of the four inputs, today's loader read all 16 orgs in full with
    zero writes. The only statements that were not reads were session settings, and a control
    write was refused.
  - The largest org loads in 1.6–1.7 s, with a peak of about 0.9 GB.
  - The in-memory shape is the same for every starting version: 77 top-level sections on the live
    copy, and 73 on the v2 inputs, which lack four newer sections.
- **Checksums before and after.** The legacy raw inventory of the org is taken before and after:
  every table of its schema, the receipt tables included (`probe/legacy_inventory.py`). Any
  difference makes that org unavailable.

**Per org, in a staging database claimed as in §2.13:**

1. Registry row `converting`, claimed. `CREATE DATABASE orgtree_stage_<n>_<epoch>`. Apply the org
   migrations, then `org_identity`.
2. Read the org through today's loader as above, with the heals a new build's first load applies
   in memory. Nothing in the legacy database is written.
3. Map each section to rows and `COPY` them.
   - **Mapper completeness.** There is one mapper per top-level section. The list comes from the
     **code**, not from the inputs. The engine keeps its own registry, `ledger.NODE_KEYED_SECTIONS`
     (ledger.py:1063–1114, 104 keys), and `tests/test_principal_identity.py` already fails when a
     written key is missing from it.
   - **Measured** (code read): 106 keys exist in all. That is the 104, plus `chain_notices`
     (legacy, nothing reads it) and `release` (read, never written). 27 of them appear in none of
     the four rehearsal inputs, for example storage limits, sandbox, disk, headless, kiosk spend
     freeze, bridge credentials, and legacy API-key fields.
   - A test fails unless the mappers declare exactly the registry's keys.
   - **Kiosk and sandbox state is not converted** (decision 17, and the user's sandbox ruling of
     2026-10-02).
     - Kiosk mode and the per-org Docker sandbox are both removed from 3.2.0
       (v3-remove-the-leftover-kiosk-feature, v3-remove-the-per-org-docker-sandbox-feature).
     - Their stored fields become ignored legacy fields, which the converter does not map:
       `kiosk`, the spend freeze, `disk`, the storage-limit flags, `sandbox_vols_base` and the
       bridge credential stamps.
     - The exact list is the engine's own constant, which both removals filled:
       `ledger.IGNORED_LEGACY_KEYS` (top-level keys; as landed, 11 keys). The removals added no
       agent-level key (the kiosk's node freeze flag stays inside the `frozen` value, which is
       kept as is). The converter imports the constant.
     - **Except `sandbox` (rev 7.2).** The sandbox removal also landed a one-time credential
       catch-up (`registry_migration.run_former_sandbox_catchup`). It finds the orgs it still
       has to catch up by their stored `sandbox` key, and in 3.2.0 it runs after the conversion,
       on the new databases. So the converter keeps `sandbox` exactly, as an org setting (a JSON
       value). The engine otherwise ignores it, as today.
     - When an ignored key holds anything but null, the report lists the org and the key. The
       value stays where it is, in the untouched legacy data.
     - The completeness test compares the mappers with `NODE_KEYED_SECTIONS` together with
       `IGNORED_LEGACY_KEYS`.
   - **Two paths can still write a key outside the registry**: `api.py:2191` copies every key of
     a hand-edited `defaults.json` into a new org, and a v1 desktop import keeps the imported
     document's keys. Such a key is not a reason to lose an org. It is kept exactly in
     `org_extra(key PK, val json)`, and counted in the report.
   - Timestamps follow §3.0 (microseconds, with the original text kept when it is not canonical).
     An unparseable one keeps its text in `extra` and is reported (Q2).
   - `mail_transitions` may live in the org schema's receipt tables (when `meta.receipt_rows` is
     set). The loader reads both forms, and the mapper maps the loaded value.
   - Today's `public.receipts` rows for the org move into its `op_receipts`.
4. Copy its side-file rows, read with SQLite's backup API, read-only.
   - **`reply-events.sqlite3`**: rows by org slug. A row whose slug is not a converted org stays in
     the old file and is counted in the report. **Measured** on a copy: 481,066 rows, 469,019 of
     them for the main org (159 MB of text). `COPY` took 15.3 s and the read-back 2.5 s. 7 rows
     carry U+0000, which goes to `extra`.
   - **`file-deliveries.db` (rev 5–7, finding f15; decision 18, option X)** has no org column.
     Each row holds `id = sha256(slug:seat:key)` (filedelivery.py:37), a fingerprint (the source
     path and caption) and the saved result. The slug is the **calling** org's, the seat is the
     calling agent's lineage token, and the key is the call's `delivery_id`. Every row is accounted
     for, none is guessed, and none is deleted:
     - **A row moves into an org's `file_deliveries`, before that org is published, only on
       evidence that names the calling org (rev 7).** Two kinds count, checked in this order:
       1. **Its snapshot folder.** `snapshot()` creates `outbox/delivery-<id>/` only inside the
          calling agent's own scratch folder, which comes from the calling org's slug
          (api.py:14785–14786), behind a containment check (filedelivery.py:39–58). The row moves
          to org O when that folder exists under O's scratch root and under no other scratch root,
          whether or not that other org converts, with links resolved. For a completed row, the
          file in it must also match the saved result: name, size and SHA-256.
       2. **A delivery key that recomputes the id.** While converting org O, the converter looks
          for keys in the transcripts of O's agents (`supervisor.transcript_path_for_node`), in
          two places:
          - the `delivery_id` argument of an `orgtree_send_file` call;
          - the key that the agent's bridge returns with a lost or unsent answer
            (mcptool.py:2366–2373). That is the case of a crash before the snapshot folder exists.

          A key K moves the row to O when `sha256(slug:seat:K)` equals the row's id, with O's slug
          and the `lineage_born` of one of O's agent rows. The hash contains the calling org's
          slug, so a key that some O agent merely read, from another org's call, cannot recompute
          the id with O's slug. Otherwise the bridge makes up the key itself and returns only the
          id, so most completed deliveries have no recorded key and rely on evidence 1. The search
          runs only for the rows that evidence 1 left, and reads only `orgtree_send_file` calls and
          their answers.
       - A folder or transcript the converter cannot read gives no evidence.
       - A row whose evidence names an org that is `unavailable` stays in the old file until that
         org's retry converts it, and then moves with it.
     - **A source path is never evidence (rev 7, review round 4).** `_node_reachable_file`
       (api.py:14769–14836) lets an agent send from its own scratch folder, its org's workspace,
       and any folder granted to it. A grant can reach another org's folders, and can be removed
       later. A source inside org A's folders therefore does not show that A sent it. The path is
       only printed in the report.
     - **A row with no such evidence** stays in the kept old file, untouched, and **is never
       deleted**: the cleanup release keeps the file while it holds such a row.
       - It is listed in the conversion report.
       - Nothing consults it any more, so a later retry with that key behaves like a new delivery.
       - That is decision 18 (option X). It keeps every org one body of data, with no live shared
         store.
     - **A limit of evidence 1 (accepted as decision 20).** If someone copies a snapshot folder
       into another org's scratch folder and then deletes the original, evidence 1 follows the
       copy. While the original still exists, the row is ambiguous and stays. When it follows the
       copy, the row is inert in its new org: no call there can produce its id, which contains the
       sending org's slug. What that org gains is the source path and caption of a file it
       already holds, and they travel with it in that org's export. The sending org is left as
       under option X. The report names the evidence used for every row, so such a case can be
       found.
     - The report counts the rows moved, by which evidence, and the rows left.
     - **Measured** (read-only, on the side copy; `probe/receipt_evidence.py`): 56 rows, all
       completed. 52 have their snapshot folder under one agent's scratch folder in the main org,
       and in all 52 the file matches the saved result. The other 4 have no folder there. I could
       read only the main org's scratch root, so they are either in another org's folders or
       deleted; the rehearsal classifies them. 33 of the 56 sources lie outside the main org's
       scratch root (its workspace or granted folders).
     - **Tests:**
       - each of: a pending receipt before its snapshot folder exists, whose key is only in the
         lost answer; a completed receipt whose folder is gone; a snapshot folder copied into a
         second org while the original remains; a row with no evidence. For each, a retry with
         the original fingerprint and with a changed caption, before and after conversion;
       - **decision 20's case (rev 7.1):** a snapshot folder copied by hand into another org's
         agent scratch folder, its original deleted, with a private caption. The row, with its
         source path and caption, moves to the copy's org. It is inert there: no call in that org
         recomputes its id. The sender's retry with the same key behaves like a new delivery
         (option X);
       - **review round 4's case:** agent B sends a file from org A's workspace through a grant
         that is later removed, and crashes before the snapshot folder exists, with no recorded
         key. The row must not move to A. It stays in the old file, untouched, is listed in the
         report and is no longer consulted. A mutant that accepts the source path as evidence
         must fail this test;
       - a key from org B's lost answer that also appears in an org-A agent's transcript (the
         agent read it) does not move B's row to A;
       - a row whose evidence names an org that fails conversion stays, and moves at that org's
         successful retry;
       - the converted org exported and imported onto a clean root with **no** old file, then the
         same retries and the missing-snapshot refusal;
       - delete and purge of the org, with the kept old file untouched.
   - Rows naming agents that no longer exist point at tombstones (§3.0).
5. Read everything back and compare each section with step 2.
   - The comparison is canonical JSON with exact types, and timestamps as instants.
   - It counts and checksums per kind.
   - It writes `conversion_runs` in the org database.
6. Rename the staging database to its final name. Then, in one app transaction, set the registry
   row `active` (or `trashed`, for a legacy trashed org). **This is the commit point.**
7. **A failure in one org** (any exception, any mismatch in step 5, or a changed legacy
   inventory):
   - drops only that claim's staging database;
   - writes the report (org, kind, record, field and both values) to
     `<data>/conversion/<time>-<pid>/`;
   - sets the row `unavailable` (step `conversion`) with a one-line reason.

   **The converter then goes on to the next org, and the engine starts with the orgs that
   converted (Q12).**

**Accounts.** `accounts-registry.json` is read and checked back in the app database's first
transaction. The file is kept, untouched.

- Machine-wide rows go to `accounts`, together with the aliases, counters and settings.
- Org-restricted rows go to their origin org's `org_accounts` (rev 4, f7). For an org that is
  unavailable, they are carried in its retry.
- A failure in the machine-wide part still refuses the start: every org's turns need it.

**Time.** Measured for the main org: load 1.7 s and reply events 15.3 s + 2.5 s. Inferred for the
rest: about 1 s to create the database, a few seconds to `COPY`, and about the same to read back.
That makes about 25–35 s for the main org, and under a minute for the whole machine, once, with the
existing "updating the database" progress.

### 5.3 Old data and rollback

**Nothing old is modified (rev 4.1, decision 14).** 3.2.0 never writes, migrates, moves or deletes
any of these:

- the legacy `orgtree` database, with its `schema_migrations`;
- the org markers in `orgs/` and `store-backend.json`;
- `accounts-registry.json`;
- `reply-events.sqlite3`, `file-deliveries.db`;
- `pre-postgres/`.

It reads them, once, in the converter's first pass.

**With the new storage on, the engine never runs today's startup routine against the legacy
database.** That routine (`claim_data_root`) writes:

- `pgstore.migrate`;
- the `workread` side-table bootstrap;
- `backfill_always_rows`;
- `retire_unmarked` / `revive_marked`, which write `public.orgs`;
- the receipt-storage conversion.

The converter reads the legacy database only through today's loader, on a pinned read-only
connection (§5.2). The measured "zero writes" of §5.4 is for exactly that path.

So **a rollback is installing the old build again**, and it runs on its untouched data:

| Old build | Rollback |
|---|---|
| 3.1.0 or 3.0.9 | It opens the legacy database it always used, at its own migration level. It does not know the new databases exist. |
| 2.1.14 | Move the files in `pre-postgres/orgs` back into `orgs/`, as today's first-launch message already says. |

Writes made in 3.2.0 are not carried back, as `pgimport`'s rollback already states. A cleanup tool
drops the new databases if the user wants the space back. The release owner checks each rollback
in the end-to-end rehearsals before publish (§5.4).

One release later, the cleanup release drops the legacy database, the markers and the old side
files (Q3). It does not drop them while any org is still `unavailable` from the import or the
conversion. That org's old data is the only copy, so the cleanup keeps it and says why. For the same reason it
keeps `file-deliveries.db` and `reply-events.sqlite3` while either holds a row that is in no org
database (§5.2, rev 5 f15).

### 5.4 Rehearsals and upgrade-path tests (decisions 4, 8 and 14)

**The three starting points, on real-data copies, before the local 3.2.0-alpha.0.** All inputs are
copies in my dev cluster, a throwaway cluster, and are recorded on the item:

| Starting point | Input | How it was made |
|---|---|---|
| 2.1.14 | `v2114import`, plus the SQLite copies it came from | The user's real pre-conversion SQLite orgs (backup-API copy) were loaded and saved once through tag v2.1.14's own store code, then imported by the first-launch importer. This is a **synthetic re-save**, approved by the coordinator. No copy written by exactly 2.1.14 exists: the user's last v2 writer was 2.1.12/13. From v2.1.12 to v2.1.14, `store.py` and `schema.py` do not change. Measured, the re-save changed exactly `models.sol` and the Sol agents' version pins (46 / 38 / 2 agents). |
| 2.1.12/13 (extra) | `v2import` | the same SQLite copies, imported without the re-save |
| 3.0.9 | `livecopy` | a read-only `pg_dump` of the live cluster, which was written by 3.0.9 (§5.1), at level 0019 |
| 3.1.0 | `lc310` | `livecopy` cloned and migrated with **v3.1.0's own** `pgstore.migrate`. The worktree's `engine/` and `tools/pypg/` are identical to tag v3.1.0. It applied exactly `0020_work_list_parse_once.sql`, and every org's five base tables are unchanged by count and sha256 (`probe/level-lc310.json`). |

**Each rehearsal checks:**

1. **Counts plus independent checksums, at both ends (rev 5, finding f16).**
   - *The source:* the raw inventory of every table of the legacy schema
     (`probe/legacy_inventory.py`), and the per-section entry counts from today's loader on a
     read-only clone (`probe/legacy_load.py`).
   - *The destination, read independently:* a separate verifier reads the new databases' actual
     relational values with plain `SELECT`s. That covers native fields, typed timestamps as
     instants, booleans and `_null` flags, links resolved to the natural keys they point at (names,
     slugs, ids), and the current history pointers. It compares them, entity by entity, with the
     values it derives itself from the source records.
     - It has its own field correspondence, written from Appendix A and the field profiles.
     - It shares no code with the converter's mappers: a source-scan test forbids it to import
       from `orgtree.convert`.
     - So a mapper error that is consistent in both directions cannot verify itself.
   - *Planted destination corruption:* after a conversion, one value in the destination is changed
     without changing its row count or the converter's report. The verifier must reject it.
   - *The legacy side is unchanged:* the legacy SQL inventory before and after, plus a file
     manifest (sha256) of the org markers, `store-backend.json`, `accounts-registry.json`,
     `reply-events.sqlite3`, `file-deliveries.db` and `pre-postgres/`, before and after. Together
     they back the rollback guarantee of §5.3.
2. **The Q12 path.** On a clone with one org given a planted fault (`probe/plant_fault.py`):
   - that org starts `unavailable` with its reason;
   - the other orgs start;
   - the faulty org's legacy data is unchanged;
   - Retry succeeds once the fault is removed.

   Planted faults whose expected outcome is "report" (an unparseable time, U+0000) must convert
   and be counted.
3. The time taken and the peak memory.
4. The read and reshape benchmarks on the result.

The results go to the coordinator, who gives p03-ws4-rcfamilies the go for the local alpha build.

**The upgrade-path tests live in the repo (decision 14 point 4)**, so later changes keep the paths
working:

- `tests/test_upgrade_paths_pg.py` runs the converter on three committed **synthetic** fixtures,
  one per starting point. A repo must never hold real data.
  - Each fixture is written by that release's own code, from a committed generator script run
    once against a worktree at the tag:
    - a 2.1.14 SQLite org (tag v2.1.14's store);
    - a 3.0.9-level and a 3.1.0-level PostgreSQL org, as plain SQL dumps of a throwaway cluster
      (those tags' own engines).
  - Each fixture covers every top-level section in `ledger.NODE_KEYED_SECTIONS`, with a manifest of
    counts and checksums.
  - The test checks the converter against the manifest with the same independent verifier (check
    1), the Q12 outcome on a planted-fault variant of each, and that the legacy input is unchanged
    afterwards.
- `tests/test_published_migrations.py` holds the checksums of the legacy migration files every
  published release shipped (3.0.0–3.0.9: 0001–0019; 3.1.0: 0001–0020). It fails if a legacy
  migration file in the repo changes, because that would make an upgrading engine refuse (or
  silently differ from) a database at that level.

**Before any 3.2.0 publish (decision 14 point 3, owned by p03-ws4-rcfamilies):**

- an end-to-end upgrade from each of the three starting points, done the way users upgrade. The
  real old build is installed in an isolated place (a throwaway Windows user or an isolated data
  root, never the live install) with real-data copies, then upgraded with the 3.2.0 installer;
- a check that the app starts and the data matches;
- a rollback check: the old build still runs on its untouched data (§5.3).

## 6. Release plan

### 6.1 What ships in 3.2.0: everything (Q9)

The user chose to ship the whole target at once. 3.2.0 converts the data and contains every part
of decision 7. Nothing is left for a later release.

| Target point | In 3.2.0 |
|---|---|
| Schema, integrity, partial indexes; one database per org; the app database | all of it: both migration folders and every table |
| Database as the source of truth; one transaction per action | every read and write goes through domain functions. **The compatibility view is deleted before the release:** a second process must not hold org state, so no path may still use it |
| Domain modules | all of §2.8 |
| Change log + `NOTIFY` | per-org `changes` and listeners. Frames carry the changed records, and the desktop renderer, the only one (no kiosk, decision 17), applies them with no refetch (§2.5). Every renderer poll is removed |
| Jobs | per-org jobs, schedulers and the sweep. Every polling loop of §2.7 is a job: delivery, watchdogs, cross-org mail, auto-resume, keepers, reminders, storage checks, retries |
| Turn queue | `turn_tickets` with leases replace `turnslots.FairSlots` (§2.4) |
| Several processes | the engine host and one worker process (§2.9) |
| Failed orgs | the `unavailable` state, its report and retry (§2.13) |

The compatibility view still exists during development. The first prototype (§6.2) and the local
alpha use it, with one process.

### 6.2 The first prototype (decision 8)

**Definition: the smallest slice that converts real data and runs the app on the new databases.**

1. Both migration folders (app and org) and the provisioning path (`CREATE DATABASE` per org,
   through the lifecycle module's admin connection).
2. The converter for every kind of record, the accounts registry and the two side files, with the
   read-back check and the report. One failing org becomes `unavailable` while the others convert
   (Q12). The 2.1.14 first-launch import holds back only a failing org (§5.1). Retry works.
3. The compatibility view: the storage layer loads and saves every kind of record through the
   mappers on the org's own database, through a per-org pool. All existing engine code therefore
   runs on the new databases, and the legacy database is never read again after conversion.

   **How it is built (rev 7.3, stage 1-B).** The storage layer keeps issuing its own SQL against
   the five legacy tables, unchanged. With the switch on, its connection is an org-database
   connection (`orgdb.compat`) that recognises each of those statements by its text and answers
   it from the org database's tables, through the section mappers and the exact codec:
   - legacy rows become views over the new tables: `doc` rows by key, `nodes` by agent name,
     log rows by a sequence number derived from the record id, `meta` rows;
   - a write is a compare-and-set against the current row, compared as canonical JSON, and
     replaces exactly that row's records inside the save's transaction;
   - a row's version (for the storage layer's lazy rows) is the version of the database row
     every write of it touches;
   - a statement the view does not know raises at once, never a silent wrong answer. A static
     test extracts every SQL statement from the storage layer's source and fails when one is
     neither served nor listed as unreachable with the switch on;
   - a few readers that bypass the storage layer's rows (presentations, node history, mail
     tails) are declined by the view, so the storage layer takes its ordinary load path for
     them.

   So the storage layer has no second code path to keep equal to the first; its behaviour with
   the switch off is byte-for-byte what it was. Equivalence is tested on built orgs and on a
   converted copy of the live data (every org loads equal; the ignored `kiosk` key aside), and
   the existing storage suites are run with the switch on, every failure classified.

   **Rev 4 (prep finding): the storage layer is not the only code on the old tables.**
   - **The size of it.** 25 other modules issue about 238 SQL statements against the old tables
     or their side tables:

     | Domain | Statements |
     |---|---|
     | agent tree | about 36 |
     | docket | about 110, including Python writes to side tables inside every save |
     | policy and watchdogs | about 11 |
     | the org list | about 11 |
     | receipts | about 56 |
     | settings | 1 |

     There are also paths that run only on SQLite.
   - **Views over the new columns are too slow for hot paths.** A view that rebuilds the old
     side tables' JSON over the new columns costs 3.6–3.8 ms per filtered lookup. Today it is
     0.04–0.24 ms. The planner cannot see through `jsonb_build_object`, so every such lookup scans.
   - **So:**
     - the agent-tree readers move to the native agents module (step 2);
     - the docket stack moves to the native docket module (step 3);
     - the small groups (policy, org list, settings, receipts) are ported in steps 1–3;
     - an old-name view is allowed only for a cold reader.
4. Native agents and docket modules: reshaping, tree reads, the per-turn neighbourhood, and docket
   access, list, get and counts, as targeted queries and short transactions.
5. The registry lifecycle for create, delete-to-trash and purge (used by the converter and the
   tests), and the `/api/accounts` and `/api/orgs` fan-outs. The org list shows an unavailable
   org with its reason and Retry.
6. Tests (§9) for all of the above.

The prototype runs as one process, with today's in-memory turn slots and today's frames. The other
3.2.0 parts (§6.1) follow in landing steps 4–8.

**A storage switch keeps v3 working between steps (rev 4).**

- Steps 1 and 2 land with the new storage switched **off** by default. `ORGTREE_STORAGE=orgdb`
  turns it on for tests and rehearsals.
- Until then the engine keeps using today's database. Every reader that is not yet ported keeps
  working, and other work landing on v3 is not broken.
- Step 3 completes the prototype and switches the default **on**. From then on the old tables are
  read only by the converter.

When the prototype passes:

1. review-sol reviews the implementation (decision 12).
2. The rehearsals run on every input (§5.4).
3. I report to the coordinator, who gives p03-ws4-rcfamilies the go for the local 3.2.0-alpha.0
   build.

### 6.3 Landing order on v3 (no release in between)

Each step is reviewed (`approve_stage`) before it lands.

| Step | Contents |
|---|---|
| 1 | App and org migrations, provisioning, the converter with the `unavailable` state, retry and the one-time marker, the first-launch import's hold-back, and the compatibility view, behind the storage switch (off). Lands as one step, because a conversion is all or nothing per org. |
| 2 | The native agents module and the agent-tree readers, still behind the switch. |
| 3 | The native docket module and the docket stack, the lifecycle and the fan-outs, the small reader groups, and the org list's unavailable entry. The accounts store (`registry.py`) reads and writes the app database's accounts tables (rev 7.3: until then the converter's copy is only a snapshot of `accounts-registry.json`). The switch turns **on**. **This completes the first prototype:** review-sol's implementation review, the rehearsals, then the alpha build. |
| 4 | The mail and watchdogs modules with their jobs; cross-org mail jobs. |
| 5 | Questions, audiences, documents, reservations, events and org settings modules. Every remaining polling loop becomes a job (§2.7). |
| 6 | The per-org change log. Frames carry the changed records, and the renderer applies them with no refetch; renderer polling is removed. |
| 7 | The turn queue goes live: `turn_tickets` with leases and `start_turn` jobs replace `turnslots`. |
| 8 | The worker process (§2.9). The compatibility view is deleted, since no path uses it any more. |
| 9 | **3.2.0 release candidate:** final rehearsals, then the coordinator's build and publish. |

## 7. Effort and risk (inferred)

| Part | Size | Main risk |
|---|---|---|
| Two migration folders, provisioning | small–medium | the admin connection leaking past the lifecycle module (a source scan test, Q10) |
| Converter + mappers (about 40 kinds) + accounts + side files | large | a legacy shape the mapper did not foresee (that org is unavailable, never lost) |
| The `unavailable` state, retry, the first-launch import's hold-back | medium | an org left half-converted (the next start redoes `converting` orgs from scratch) |
| Compatibility view per org database | medium | a whole-collection walk left on a hot path (the growth tests catch it) |
| Native agents and docket modules | large | behaviour drift (today's suites are the contract) |
| Org lifecycle, fan-outs, listeners per org | medium | a pool or listener leak (tests count open connections) |
| Mail, jobs, the other modules | large | delivery ordering and duplicates (the custody tests stay) |
| Every polling loop as a job | medium | a condition that no transaction schedules (each loop's behaviour test must pass with the loop removed) |
| Feed frames with records; the renderer applying them | medium–large | the renderer drifting from the database (a test compares its state after frames with a full load) |
| Turn tickets with leases; the worker process | medium–large | lease handling; a turn started twice; a request that never reaches the owning process |
| Deleting the compatibility view | medium | a rare path still on it (a source scan test: no import of it remains) |

## 8. Measurements

### 8.1 What does not change

**Inside an org.** All 25 lookups and 4 writes of the rev 2 prototype were re-run inside a dedicated
database holding only the live org's prototype tables (`porg2`, restored from a one-org dump).
Results are in `probe/proto-cost-porg2.json`; the "shared tables" column is the rev 2 prototype
(`probe/proto-cost.json`).

| Lookup or write | Today (audit) | Shared tables (rev 2) | Own database (rev 3) |
|---|---|---|---|
| Re-parent 400 agents | 1,006 ms with triggers; 657 ms engine CAS | 6.2 ms | **6.4 ms** |
| Generation change on 400 agents | 1,788 ms | 5.1 ms | **4.3 ms** |
| Cost-only change on 400 agents | 717 ms | 4.3 ms | **4.1 ms** |
| Deliver 200 mails | 243 ms | 2.4 ms | **1.9 ms** |
| Children of the 483-child seat | 1.2 ms | 0.20 ms | 0.18 ms |
| Ancestors / descendants (1,145) | – | 0.23 / 3.6 ms | 0.11 / 3.1 ms |
| Live / frozen-live / halted / accounts | 0.24 / 153 / 40 / 93 ms | 0.04 / 0.07 / 0.05 / 0.03 ms | 0.06 / 0.04 / 0.04 / 0.03 ms |
| Cost total | 54 ms | 0.13 ms | 0.13 ms |
| Lineage count (62 generations) | trigger-kept | 0.19 ms | 0.16 ms |
| Docket counts by status | 1,000–1,183 ms | 0.22 ms | **0.18 ms** |
| Docket readable, first page (leaf / coordinator / user) | 58–71 ms | 0.46 / 2.1 / 0.2 ms | **0.38 / 1.6 / 0.19 ms** |
| Archived item by slug / by owner | 108 / 130 ms | 0.05 / 0.03 ms | 0.02 / 0.03 ms |
| History: events / notices | 74 / 38 ms | 0.14–0.20 / 0.07 ms | 0.13–0.24 / 0.04 ms |
| Sent, newest 50 | 0.06 ms (side table) / 293 ms (JSON) | 0.07 ms | 0.05 ms |

As expected, nothing moves: every query was already per org. Without the `org_id` prefix the
indexes are slightly smaller.

### 8.2 What is new

| Cost | Measured | Where it matters |
|---|---|---|
| Opening a connection (first query included) | 16.7 ms median (15.5–22.7) | the first request to a cold org; the fan-outs (§2.6) |
| An idle backend | 4.2 MB private, 19.8 MB working set | the connection budget (§2.11) |
| `CREATE DATABASE` (empty) | 0.63 s | create, import, conversion |
| `DROP DATABASE` | 0.26 s | purge |
| One-org dump (the live org's tables, compressed) | 2.2 s, 25 MB | export, move |
| One-org restore (into a new database, indexes included) | 5.7 s, 112 MB on disk | import, move |
| `max_connections` | 40 today (dev and live); 100 from 3.2.0 | Q11, decided |

### 8.3 Expected end to end

The same estimates as rev 2 (inferred, replaced by measurements at the first prototype):

| Screen or operation | Today | Expected |
|---|---|---|
| Tree after a commit | 1.2–1.45 s | under 50 ms (change-log catch-up) |
| Docket list | 66–87 ms | 5–15 ms |
| History panel | about 150 ms | under 10 ms |
| Per-turn prompt | ≈140 ms | 10–30 ms |
| Desk chat | 158–244 ms | under 60 ms |
| Big reshape | 0.74–0.96 s | 0.1–0.3 s |
| `GET /api/accounts` | loads every org whole | under 2 ms warm / about 20 ms cold for 4 orgs |
| The first request to a cold org | – | +17 ms to open its pool |

## 9. Tests

**Rev 7.2 (decision 21):** an agent's list calls carry no archived total unless the archive is
requested, so rev 2's "no growth with history" test below holds for every docket path again,
with no exception (A.3). The agent list payload tests change with it: an archived count appears
only with `include_archived`.

**Rev 7 adds the tests of review round 4**: the receipt cases in §5.2 (a source path is not
evidence, with its mutant), and the split guards and the tree-move guard in Appendix A.3. (It
also gave an agent's direct pass a timing condition instead of the row bound; decision 21 removed
that pass.)

**Rev 6 adds the tests named under each finding of review round 3** (§2.4, §3.0, A.3, §5.2).

**Rev 5 adds the tests named under each finding of review round 2** (§2.2, §2.4, §2.5, §2.13,
A.3, §5.2, §5.4).

**Rev 4.1 adds the upgrade-path tests of decision 14** (`tests/test_upgrade_paths_pg.py`,
`tests/test_published_migrations.py`, §5.4).

**Rev 4 adds the tests named under each finding.** They are listed where each finding is answered:

| Section | Findings |
|---|---|
| §2.2 | f1 |
| §2.4 | f2 |
| §2.5 | f8, f9 |
| §2.13 | f6, f10 |
| §3.0 | f11, f12 |
| §5.2 | f3 |
| Appendix A.3 | f5, f13 |

They come on top of everything below. For the race findings (f1, f2, f6, f8), every test is a
two-session or two-process barrier test, paired with a mutant that removes the guard and must fail.

Rev 2's tests, unchanged:

- round trip per kind;
- no JSON in lookups (`EXPLAIN` guards and a source scan);
- no growth with history at 1× and 10×;
- integrity refusals;
- concurrency;
- access equivalence with `_work_can_read`;
- the behaviour suites as the contract;
- mutants on the risky code.

Added for rev 3:

1. **Per-database migrations.** A partly migrated set (org A at N+1, org B at N) is finished at the
   next start. An org newer than the build, or with a failing migration, becomes `unavailable`
   with its reason while the other orgs start. Its database stays at its last good level. A
   failing or newer app database refuses the start.
2. **Lifecycle.** Each step of create, trash, restore, purge, export and import is killed at every
   intermediate state and finished by the next start. After purge, no row in the app database and
   no database or folder of the org remains. An import of an `org_uuid` already registered is
   refused. `org_identity` mismatch refuses to serve.
3. **Connections.** Pools open lazily and close when idle. A fan-out over N orgs opens at most its
   concurrency limit of connections. The per-process cap queues rather than failing.
4. **Cross-database steps.** A crash between the sender's commit and the delivery job, retried,
   delivers exactly once. Likewise a crash between the `start_turn` job and the ticket insert.
5. **Conversion.** Fixtures for both starting points, including the accounts file and the side
   files. For every planted fault:
   - the faulty org becomes `unavailable` with its message, and its half-built database is gone;
   - the other orgs convert and start;
   - nothing is written to the legacy store or the old files (checksums before and after);
   - the partly converted set resumes correctly.

   A fault in the accounts file refuses the start.
6. **Failed orgs (Q12).**
   - The first-launch import holds back only the faulty SQLite org, and its file still moves to
     `pre-postgres/orgs` unchanged.
   - After the fault is removed, Retry converts the org for each of the four steps.
   - Automatic retry happens once per new build and not at every restart.
   - Mail to an unavailable org waits and is delivered once after retry.
   - The org list and `/api/accounts` show the org as unavailable.
7. **Jobs instead of loops.** With every polling loop removed, each loop's behaviour test still
   passes, driven only by jobs. A test fails if any process sleeps in a loop that reads org
   tables.
8. **Feed.** After any sequence of frames, the renderer's store equals a full load. A missed
   frame is detected as a gap and caught up. Other audiences receive only what their reads would
   return.
9. **Turn queue and two processes.**
   - Fairness across orgs and the slot limit hold, as in today's `turnslots` tests.
   - A killed worker's leases expire, and its jobs and tickets run once elsewhere.
   - No turn is started twice.
   - An interrupt sent to the host stops a turn the worker owns.
10. **Admin connection (Q10).** A source scan fails if any module other than the org-lifecycle
    module reads the admin URL or opens that connection, or if the worker can reach it.

## 10. Review round 1 (review-sol, 2026-10-02), and the questions

| Finding | Severity | Rev 4's answer | Where |
|---|---|---|---|
| f1 tree loops under concurrent moves | blocking | one topology lock row per org, plus a deferred row-level constraint trigger that checks the lock and walks up at commit | §2.2 |
| f2 turn identity and stale workers | blocking | `turn_requests` with a permanent `request_id`; tickets unique on it forever; cancellation upserted by it; numbered claims checked on every write; leases per process; the host kills a silent worker (whose providers die with its job object) before reclaiming | §2.4 |
| f3 reconversion after trash or purge | blocking | one first pass, ended by the `legacy_cutover` marker; legacy trashed orgs become trashed, and orphans stay unconverted; afterwards only an explicit Retry of a named org | §5.2 |
| f4 | (folded into f6 by the reviewer) | | |
| f5 cleared review pointers | blocking | explicit nullable `current_verdict_event_id` and `current_review_packet_event_id` | A.3 |
| f6 lifecycle exclusivity and quiescence | blocking | per-org claim with an epoch on every transition; staging databases named by attempt; cleanup only of its own claim; publish last; close, fence the database, stop the turns, then move | §2.13 |
| f7 org-restricted accounts | blocking | they move into their org's database; the app database keeps machine-wide accounts and the id counters | §2.10 |
| f8 feed snapshot and cursor | blocking | the baseline and the cursor from one snapshot; catch-up with explicit from/to bounds in one snapshot; tombstones; a floor for retention; catch-up on every reconnect; the cursor carries `org_uuid` and `incarnation` | §2.5 |
| f9 visibility changes in the feed | should-fix | record frames only for the desktop, which reads everything; every other audience gets revision-only frames and refetches its own view | §2.5 |
| f10 export and import cut | blocking | export after quiescence, from one exported snapshot, with a file manifest, verified before completion; import verifies the source before migrating and rewrites a clone's identity explicitly; account-id collisions are re-keyed | §2.13 |
| f11 seat versus generation identity | should-fix | (superseded in rev 6 by f17: one row per node, no seat table) a `seats` table; current-seat references point at seats and historical ones at generation rows; legacy references convert by today's continuity rule | §3.0, A.2, A.3 |
| f12 microsecond timestamps | should-fix | native microseconds, plus the original text when it is not canonical | §3.0 |
| f13 docket cost growing with history | should-fix | active rows only, a walk up from the anchor per row, a page limit, counter rows for archived totals, and a live-only account index; 1×/10× guards | A.3, A.2 |
| f14 the dedicated schema | minor | schema `orgtree` in every database; rev 3.1's reinterpretation withdrawn | §3.0 |

**Review round 2 (review-sol's re-review of rev 4.1, 2026-10-02).** Accepted: f3, f5, f7, f12, f14.
Rev 5 answers the rest:

| Finding | Severity | Rev 5's answer | Where |
|---|---|---|---|
| f1 | blocking | the guard takes the topology lock itself (no caller-set marker), re-reads the final row, and fires on `INSERT` too; a no-self-parent CHECK; a whole-table cycle check after conversion | §2.2 |
| f2 | blocking | a running cancellation becomes `stopping` and keeps its slot and agent until the provider has stopped; the epoch is raised; run operations require `state = 'running'` under a share lock; start validates the org request; the ticket columns are aligned | §2.4, §3.1 |
| f6 | blocking | two fences: a runtime fence (`REVOKE CONNECT` from the runtime role, its backends terminated) under which the admin drains, then the no-connections fence only for rename and drop; restore and import rewrite and check `org_identity` before the runtime reconnects; `closing` added to the states | §2.10, §2.13 |
| f8 | blocking | a proof that an overlapping coalesced frame is safe to apply whole; the client rule (ignore when `to <= c`, apply when `from <= c < to`, catch up when `from > c`); one ordered pipeline for baselines, catch-ups and frames | §2.5 |
| f9 | should-fix | moot: decision 17 removes kiosk, so the desktop is the feed's only audience | §2.5 |
| f10 | blocking | export uses the runtime fence only; the admin snapshot keeper and `pg_dump` connect under it | §2.13 |
| f11 | should-fix | authorization keeps today's name predicate (names stored beside the seat references), assignment keeps the seat predicate; two oracles | A.3, A.7 |
| f13 | should-fix | desktop totals from global counters; agent totals from per-anchor counters over the subtree plus deduplicated direct items; maintenance rules; the generated anchor uses same-row name columns | A.3 |
| f15 | blocking | a receipt moves only on unique evidence (its outbox folder); every other one stays live in the old file and moves on first use; cleanup keeps the file while any remain | §5.2, §5.3 |
| f16 | should-fix | an independent destination verifier that reads the relational values with its own field map and no converter code; a planted destination corruption it must reject; file manifests of the old files | §5.4 |

**Review round 3 (review-sol's review of rev 5, 2026-10-02).** Accepted: f1, f6, f8, f10, f16; f9
moot. Rev 6 answers the rest:

| Finding | Severity | Rev 6's answer | Where |
|---|---|---|---|
| f2 | blocking | the request states are aligned (`stopping` added, and the ticket index covers it); a durable two-step handshake: the job compare-and-sets `pending → queued` first and may continue on `queued`, then inserts the ticket idempotently, so no ticket exists for a `pending` request; cancellation by state at every boundary, serialized with start on the org request row | §2.4 |
| f11 | should-fix | the ancestry anchor is the one non-deleted row with exactly that name, head or archived bearer, walking its own parent chain; no head filter | A.3 |
| f13 | should-fix | the coordinator's ruling B: `docket_subtree_counts` maintained in O(depth) per change, moves included, for the subtree part; one indexed query for the direct part; the 10×/5% p95 condition, with a maintained direct counter if it fails | A.3 |
| f15 | blocking | the coordinator's ruling X: rows move into their org before publish on durable evidence (outbox folder, org-private source path, transcript hash match); a row with none stays in the kept old file, never deleted, listed, and not consulted | §5.2 |
| f17 | blocking | one `agents` row per legacy node, each its own principal and mailbox; `lineage_born` is a non-unique lineage token; no seat table; current-holder references resolved to the node by today's continuity rule; historical ones typed as recorded | §3.0, A.2, A.3 |

**Review round 4 (review-sol's review of rev 6, 2026-10-02).** Accepted: f2, f11 and f17, f13's
direct query (subject to its timing condition), and f15's option X. Rev 7 answers the two points
reopened:

| Finding | Severity | Rev 7's answer | Where |
|---|---|---|---|
| f13 | should-fix | the history-dependent fallback counter is withdrawn: if the direct pass fails its timing condition in the prototype, the coordinator rules again on the measured numbers; the guards are split into the row bound (every other path), the timing condition (the direct pass only) and a tree-move guard | A.3, §2.3 |
| f15 | blocking | a source path is no longer evidence; a row moves only on its snapshot folder (in one org only, with the file matching the result) or on a delivery key that recomputes its id with the org's slug and an agent's lineage token; review round 4's grant case is a test, with a mutant | §5.2 |

**After the approval (rev 7.2): decision 21** removed f13's direct pass, its timing condition and
the two counters that served agents' totals. An agent's list calls carry no archived total unless
the archive is requested; the desktop keeps its totals (Appendix A.3).

## 10.1 Questions: all answered

Q9–Q12 are answered (see the table at the top) and folded in.

**Details I filled in while folding in the answers.** These are mine, not the user's. The
coordinator accepted all seven (decision 13); D2 and D4 went to the user, who may overrule them.

| # | Detail | Where |
|---|---|---|
| D1 | The Q12 rule also covers an org whose later migration fails, whose database is newer than the build, or whose identity check fails. A failure in the app database or the accounts still refuses the start, because no org can run without them. | §2.12, §5.2 |
| D2 | The 2.1.14 first-launch import holds back only the failing org, instead of refusing every org. The held-back org's file still moves, unchanged, to `pre-postgres/orgs`. | §5.1 |
| D3 | Retry runs when the user asks, and once automatically when a different build starts. It does not run at every restart. | §2.13 |
| D4 | An unavailable org offers only Retry in 3.2.0, with no trash or purge, because its data is not in the new layout. | §2.13 |
| D5 | The cleanup release keeps the legacy database and the old files while any org is still unavailable from the import or the conversion. | §5.3 |
| D6 | The second process is one worker, a child of the engine host, with no port, no owner lock and no admin connection. Both processes run jobs and turns. | §2.9 |
| D7 | Timers that read outside state (provider usage, update checks, the mail hub) stay timers in the engine host. They do not scan the database for work. | §2.7 |

## Appendix A. The org database's tables in full

This is rev 2 §3.1–§3.10 with `org_id` removed. Every key is a plain surrogate `id`; every foreign key
is a plain one inside the org database.

### A.1 Settings

**`org_settings`** is one row of typed columns for the scalar settings in `OrgDoc`:

- name, version, workspace;
- permission_mode, default_visibility, default_effort;
- max_top_grant, default_top_grant, compact_at;
- fable policies, cascade switches, max_depth, max_children;
- auto-resume fields, net switches, API-key fallback fields;
- cost accumulators and heal markers.

No kiosk, sandbox, disk, storage-limit or spend-freeze setting exists in 3.2.0 (decision 17). The
converter does not carry them (§5.2), except the stored `sandbox` value, which it keeps as a JSON
column for the former-sandbox credential catch-up to read (rev 7.2); nothing else reads it.

The object-valued settings (`killswitch`, `net_identity`, `fable_lock`, `auto_cheap_compact`) are flattened into columns where their shape is fixed; otherwise they are one
JSON column each.

Setting lists, one row each:

| Table | Holds |
|---|---|
| `org_dirs(path, mode)` | folder grants |
| `org_tiers(tier, price, model)` | today's `tiers` and `models` |
| `org_default_mcp(server)` | default MCP servers |
| `net_hubs(id, address, enabled, name)` | hubs |
| `net_hub_seen(hub_id, message_id)` | seen hub messages |
| `net_spool(hub_id, seq, …)` | outgoing hub spool |
| `retired_slugs(slug)` | docket names that can't be reused |

### A.2 Agents

**`agents`** holds hot columns only, one row per legacy node: every independently addressable agent
(§3.0, rev 6). It replaces `nodes`,
`node_index`, `foreground_meta`, `foreground_parents` and `node_tree_val`.

| Group | Columns |
|---|---|
| keys | `id`; `name` (today's node id); `lineage_born` (today's `seat_id`: a lineage token, not unique); `generation` (this node's own counter); `ord` (the stable display order today's walks produce) |
| tree | `parent_id` → agents (NULL = top level); `ui_order`; `created`; `archived_at`; `rescinded_at` |
| state | `state CHECK (live, archived, unrecoverable, deleted)`; `title`; `model`; `credit_grant numeric` |
| lineage | `lineage`; `predecessor_id` → agents; `successor_id` → agents; `bearer_state CHECK`; `lost_reason` |
| session | `session_id`; `transcript_incarnation`; `reply_incarnation`; `pid`; `session_began_at`; `session_unrun`; `cheap_compacted`; `compacted_unrun` |
| accounts | `account`; `account_primary`; `codex_account`; `codex_thread`; `antigravity_account`; `antigravity_conversation`. These name accounts in the app database by their stable id: a soft reference, since it crosses databases. |
| mail | `mailbox_id UNIQUE`; `mail_seq` |
| scope (flattened) | `permission_mode`; `org_visibility`; `effort`; `account_fallback`; `model_version`; `prefer_reserve`; `tool_bash`, `tool_web`, `tool_edit`, `tool_subagents`; `cheap_compact_enabled`, `cheap_compact_occ` |
| usage | `cost_usd`; `cost_usd_unknown`; `context_window`; `occupancy`; `occupancy_est`; `cli_compactions`; `cli_boundary_offset`; `turn_seq`; the two estimate tuples as columns |
| status | `last_status_status`, `_summary`, `_at`; `prev_status_*` |
| runtime markers | `limit_locked`; `config_seq`; `hard_fail_run`; `limit_run`; `net_fail_run`; `net_fail_since`; `untrusted_limit_run`; `docket_reminder_at`; `working_activity_at`; `cache_keepalive_at` |
| tool inventory | `last_turn_mcp_tool_count`; `last_turn_mcp_fingerprint`; `tool_list_id` → `tool_lists` |
| presence flags (partial-index targets) | `is_frozen`, `is_halted`, `is_remote_controlled`, `has_pending_switch`, `is_inflight` |
| bookkeeping | `extra`; `row_version` |

**Indexes on `agents`:**

| Index | Serves |
|---|---|
| `(parent_id, ui_order, created, ord)` | children in display order |
| `(ord) WHERE state = 'live'` | live agents |
| `(parent_id, ui_order, created, ord) WHERE state = 'archived' AND successor_id IS NULL` | the retired pile under a seat |
| `(predecessor_id)`, `(successor_id)` | lineage walks |
| `(lineage_born)`, `(session_id)` | a lineage's nodes, lookups by session |
| `UNIQUE (name) WHERE state <> 'deleted'` | names |
| partial indexes per presence flag | "which agents are frozen, halted …" |
| `(account) WHERE state = 'live' AND account IS NOT NULL` | the `/api/accounts` fan-out: live agents only (rev 4, f13) |
| a name gram index (today's `orgtree_id_grams`) | canvas search |

**One-to-one cold tables:**

- `agent_texts(agent_id PK, charter, team_charter, team_charter_null)`.
- `agent_runtime(agent_id PK)`, one JSON column per shapeless payload (Q1): `frozen`, `halt`,
  `inflight`, `turn_ended`, `pending_switch`, `remote_controlled`, `admit_once`, `unstuck`,
  `last_wall`, `cache_continuity`, `envelope`, `codex_route_last`, `codex_usage_total`,
  `codex_usage_reset`, `desktop_import`, `mail_drain_state` (its id list moves to a link table).

**Child and link tables:**

| Table | Kind | Notes |
|---|---|---|
| `agent_dir_grants(agent_id, pos, path, mode CHECK (rw, ro))` | many-to-many agent ↔ folder | index (path) |
| `agent_mcp_servers(agent_id, pos, server)` | many-to-many agent ↔ server | index (server) |
| `agent_tool_prompts(agent_id, kind CHECK (denial, approval), pos, tool, arg, cwd)` | owned list | `last_denials`, `last_approvals` |
| `tool_lists(id, sha256 UNIQUE)`, `tool_list_items(list_id, pos, tool)` | a value shared by many agents | measured: 40 distinct lists over 1,045 agents, so 71,000 stored names become about 2,700 rows |
| `agent_carriers(agent_id, pos, halt_id, text, view, ping, ping_reason, from_*, at, delivery_id, claim json)`, `carrier_mail(carrier_id, mail_id)`, `carrier_tokens(carrier_id, tok)` | owned list + links | `halt_queue`, `native_held_carriers` |
| `agent_mail_drain(agent_id, mail_id)` | many-to-many | the waking mail ids |
| `agent_turns(agent_id, n, at, cost, ms, toks, denials, approvals, ran_as, killed, estimated, cost_complete, cost_source, route json, reported json, …)` | owned log | PK (agent_id, n); index (agent_id, n DESC). One table for **both** the agent's `turns` list and the `turn_log`. Measured: for 1,106 of 1,187 agents, the stored list is exactly the log's last 8 rows; the other 81 predate the log. The tree reads `LIMIT 8` from the index; `node_tree_val` goes away. |
| `agent_turn_errors(agent_id, seq, at, text, ran_as)` | owned log | today's `turn_error_log` |
| `agent_external_handles`, `agent_oracle_exchanges` | owned lists | retired and rare fields, kept exactly |

**Tree queries** (indexed SQL; times in a dedicated database, §8):

| Query | Time |
|---|---|
| children of the 483-child seat | 0.18 ms |
| ancestors (at most 6 levels on live data) | 0.11 ms |
| descendants of the 1,145-agent subtree | 3.1 ms |
| lineage count of 62 generations | 0.16 ms |

**No closure table.** The tree is at most 6 levels deep (average 1.9). A closure table would rewrite
up to 1,145 × depth rows on a big move: today's trigger cost again, under another name. Decision 3
asks for this justification.

### A.3 Docket

**`work_items`** holds active and archived items together. It replaces the active `doc` rows, the
archive log rows, `work_index`, `work_list_summary` and all of `work_read_*`.

| Group | Columns |
|---|---|
| keys | `id`; `slug UNIQUE`; `rev` |
| identity | `kind CHECK`; `title` |
| status | `status CHECK`; `status_at`; `blocked_reason`; `waiting_reason`; `dropped_reason` |
| people | for authorization, by name (rev 5, f11): `owner_name`, `reviewer_name`, `created_by_name`, and `anchor_name`, generated as `coalesce(owner_name, created_by_name)` on the same row; for who holds the item (rev 6, f17): `owner_agent_id` → agents (+ `owner_generation`, `owner_born`, `owner_deleted` as recorded), `reviewer_agent_id` → agents (+ `reviewer_generation`, `reviewer_born`); historical, as recorded: `created_by_*`, `last_updater_*` (principal kind, name, generation) |
| current pointers (rev 4, f5) | `current_verdict_event_id` → work_item_events, `current_review_packet_event_id` → work_item_events; both nullable |
| times | `created`; `updated_at`; `docket_at`; `archived_at` (NULL = active) |
| links | `parent_item_id` → work_items; `superseded_by_id` → work_items |
| attention | `attention_reason`, `attention_at`, `attention_by_*`, `attention_set_rev`; `manual_attention_rev`; `notification_attention_active`, `notification_attention_epoch` |
| completion | `accepted_at`, `accepted_by_*`, `accepted_note`, `accepted_via`, `accepted_evidence_gap`; `post_completion json` |
| sequences | `scope_seq`, `scope_guard`, `scope_rolled`, `scope_logged`, `artifact_seq`, `finding_seq` |
| bookkeeping | `extra`; `row_version` |

The description (`objective`) lives in `work_item_texts(item_id PK, objective)`.

**Indexes on `work_items`:**

| Index | Serves |
|---|---|
| `(coalesce(docket_at, updated_at) DESC, slug DESC) WHERE archived_at IS NULL` | the active list order (rev 4, f13: active rows only) |
| `(archived_at DESC, id DESC) WHERE archived_at IS NOT NULL` | archive pages, keyset |
| `(anchor_name, archived_at DESC) WHERE archived_at IS NOT NULL` | an agent's archive page through its subtree |
| `(status) WHERE archived_at IS NULL` | active-only filters and header counts |
| `(owner_name)`, `(reviewer_name)`, `(created_by_name)`, `(owner_agent_id)`, `(reviewer_agent_id)` | lookups by person, for authorization (names) and for assignment (agent rows) |
| `(anchor_name)` | the access rule's anchor |
| `(parent_item_id)`, `(superseded_by_id)` | child items and supersessions |
| `(attention_set_rev) WHERE attention_reason IS NOT NULL` | attention raises |

**Child and link tables:**

| Table | Kind |
|---|---|
| `work_item_participants(item_id, agent_name)` | many-to-many by name, as today's authorization reads them (rev 5, f11); indexes both ways |
| `work_item_dependencies(item_id, depends_on_id)` | many-to-many; indexes both ways |
| `work_item_holders(item_id, seq, agent_id, generation, born, from_at, by_*, derived)` | owned list; index (agent_id) for the item-scoped read grant |
| `work_item_acceptance(item_id, idx, text)` + `work_item_acceptance_checks(item_id, idx, seq, …)` | owned list + its list |
| `work_item_progress(item_id, list CHECK (done, next), pos, text)` | owned list |
| `work_item_events(item_id, seq, at, by_*, kind CHECK (history, evidence, decision, scope, verdict, review_packet, dismissal, …), …)` | the item's **append-only history as rows** (decision 7 point 2): one sequence of typed events, with kind-specific columns and a content column for free text. **The current verdict and the current review packet are explicit pointers (rev 4, finding f5)**, not the newest event: `current_verdict_event_id` and `current_review_packet_event_id`, NULL when none is current. Today reopen clears the verdict, and `changes` / `approve_stage` clear the packet, while the history keeps every event (ledger.py:16424–16437, 19601–19607, 19678–19684). The pointers do the same. Conversion: a non-null legacy value points at its event (measured: all 420 non-null verdicts and all 52 non-null packets equal the last entry); a value matching no event makes the org unavailable, naming the record; null stays NULL. Tests: approve_stage then the packet is cleared; reopen then the approval is cleared; changes then the packet is cleared; archive and reopen; and the API output for each, before and after conversion. |
| `work_item_review_seats(item_id, seq, reviewer_id, holder_id, …)`, `work_item_review_seat_requests(item_id, seq, …)` | owned lists with state |
| `work_item_artifacts(item_id, artifact_id, …)` + `work_item_artifact_grants(item_id, artifact_id, agent_id)` | owned list + many-to-many |
| `work_item_findings(item_id, finding_id, …)` + `work_item_finding_decisions(…)` | owned list + its list |
| `work_item_delivery(item_id, stage, …)` | owned, at most 5 stages |
| `work_item_quick_staff_receipts(item_id, receipt_id, …)` | owned list |

**Docket access is a query.** The rule (`Org._work_can_read`) is that these may read an item:

- the user;
- the owner, the creator, the reviewer, or a participant;
- a strict ancestor of the owner (of the creator when there is no owner).

Rev 3 expanded every descendant of the viewer, archived ones included, and then filtered every
item, archived ones included. Its cost therefore grew with history (rev 4, finding f13). Rev 4 keeps
the rule and changes the direction of the walk:

- **Two predicates, kept apart (rev 5, finding f11).** Today the docket answers two different
  questions, and the new model keeps both exactly:
  - **Who may read or manage an item** (`_work_can_read`, ledger.py:13170–13195) works on
    **names**: the owner's, creator's and reviewer's node names (ledger.py:12823–12825 takes only
    the name from a holder reference), the participants' bare names, and the strict ancestors of
    the agent now holding the owner's name (the creator's when there is no owner). A same-name
    hire after a delete therefore gets today's answer.
  - **Who still holds the assignment** (`_work_identity_state`) works on the node a reference
    resolves to: `born`, else the directional generation rule, else `deleted` (§3.0, rev 6).
  - The item therefore stores, per role, both what the record says and the identity it resolves
    to:
    - `owner_name`, and `owner_agent_id` (+ `owner_generation`, `owner_born`);
    - `reviewer_name`, and `reviewer_agent_id` (+ `reviewer_generation`, `reviewer_born`);
    - `created_by_name`, historical, as recorded;
    - participants by name, in `work_item_participants(item_id, agent_name)`.
  - The names are not foreign keys. A name can outlive its agent, exactly as today, and that is
    the behaviour being preserved (Appendix A.7). Moving authorization to agent rows would be a
    product change that needs a ruling; this design does not make it.
- **The point check `docket.can_read(item, viewer)`** is today's name rule, in this order:
  1. the user;
  2. the viewer's name equals `owner_name`, `created_by_name` or `reviewer_name`, or is one of the
     item's participants (index `(agent_name, item_id)`);
  3. otherwise it resolves `anchor_name` to the one non-deleted row with exactly that name (rev 6,
     finding f11). That is the head `x` or an archived bearer such as `x@0`, whichever carries the
     name. It then walks **up** that row's own `parent_id` chain, at most the tree depth (6 today),
     looking for the viewer's name.
     - It never substitutes another node of the lineage, and it adds no head or state filter.
       That is today's rule: `_work_can_manage` (ledger.py:13170–13181) and `ancestors`
       (1832–1850).
     - An absent or deleted name gives no ancestor access, as today.
     - Tests: an item anchored at an archived bearer whose parent chain differs from the head's;
       a live namesake; an absent name. These run for both the read/manage oracle and the totals.

  This is the same predicate as rev 3's descendant set (a strict ancestor of X is exactly a node
  met walking up from X). It adds no `state` filter, so access to items owned by retired agents is
  unchanged. Its cost is at most the tree depth in key lookups, whatever the history.
- **The active list** reads only `WHERE archived_at IS NULL`, through the partial order index. It
  applies the point check to each row and stops at the page size:

  ```sql
  SELECT i.* FROM work_items i
  WHERE i.archived_at IS NULL
    AND ($viewer_is_user OR docket.can_read(i.id, $viewer_name))
  ORDER BY coalesce(i.docket_at, i.updated_at) DESC, i.slug DESC
  LIMIT $page
  ```

  Rows read are bounded by the active items: 12 to 102 on the four orgs measured, never the 1,075
  archived ones.
- **Totals (rev 7.2, decision 21; it replaces rev 5–7's agent counters and decisions 18–19's
  f13 part).** A total counts only what its viewer may read.
  - *The desktop*, the user, reads everything.
    - Active counts per status come from `count(*) … WHERE archived_at IS NULL` over the partial
      index.
    - The archived and backlog totals come from `docket_counters(kind, n)`, updated in the
      transaction that archives, unarchives, backlogs or unbacklogs an item. They are O(1),
      nothing reads the archive, and a tree move does not touch them.
  - *An agent's* docket list header and `orgtree_work list` totals carry `attention`, `active` and
    `backlogged`, over items that are not archived. They carry **no archived total**: the
    archived group's line says only how to ask for it (`include_archived`). An agent's archived
    total comes only from an explicit archive request, and is then the number of archived items
    served.
    - These totals are the sizes of the agent's readable set among the non-archived rows, from the
      active list's own pass (the point check per row, above). They are bounded by the active
      items.
  - A row that is in the archive but still holds attention is served on the main list, as today
    (attention outranks the archive in `_work_archived`). A partial index on the archived rows
    that hold attention finds them, bounded by the rows holding attention, not by the archive.
  - No counter serves an agent's totals, so a tree move or a rename changes no total row.
  - **What changes from today (decision 21):** an agent's `work_list` totals and `groups` stated
    the archived count even when the archive was not listed (`ledger.work_list`,
    `_work_list_payload`). They now state it only when the archive is requested. The desktop's
    header is unchanged. The tests that expected an agent's archived count change with it.
  - **Why (measured 2026-10-02, `probe/d19_probe.py` on the converted main org):** the
    agent-side archived total needed a pass over the viewer's own direct items, and it grew in
    step with them: for coordinator-opus, 0.96 ms at p95 1.75 ms with its 344 archived direct
    items, 10.7 ms at p95 14.2 ms with ten times as many. Rev 7's alternatives were a counter
    whose upkeep on a tree move grows with history (withdrawn by decision 19), or no archived
    total for agents (rev 6's option C, now chosen).
  - **Guards:**
    - The authorization oracle checks every total and group count.
    - The seeds include hidden archived and backlog rows, anchors at archived bearers, and access
      changes that involve no archive transition: a move, a new participant, a new owner, a
      rename, a delete followed by a same-name hire.
    - The performance guards are under "Guards (§9, rev 7.2)" below.
- **Archive requests are cold reads**, opened explicitly (`include_archived`, archive pages).
  - For the user: a keyset page over the archived index, so rows read are bounded by the page
    size.
  - For an agent: the direct-principal lookups by key, plus the archived items anchored in its
    subtree through `(anchor_name, archived_at)`. Rows read are bounded by what that agent may
    see, never by the whole archive.
  - The archived total such a request returns counts the archived items it serves.
- **`anchor_name`** is `coalesce(owner_name, created_by_name)`, a stored generated column over
  two columns of the same row (rev 5, f13).

**Measured** (rev 3, before this change): the rule as SQL returns exactly the engine's 5,041 (item,
reader) pairs on the live copy, with 0 differences (`probe/access_rule_check.sql`).

The point check must reproduce `_work_can_read` on every (item, reader) pair of every rehearsal
input, plus fixtures for a delete followed by a same-name hire. That is a test (§9), with the
Python predicate as the oracle. Where the two would differ, today's answer wins unless the user
rules otherwise.

**Guards (§9, rev 7.2).** Each docket path is checked with `EXPLAIN` and a rows-examined count.
Archived agents and archived items are seeded at 1× and 10×, and archived rows are interleaved
ahead of active ones in the sort order. Then four rules apply:

- **The row bound, for every path.** List and its totals (without the archive), get, the account
  fan-out, the desktop's counts, and every item change with its counter upkeep: the statement
  counts and rows read must not change between 1× and 10×. (Rev 7 exempted an agent's direct pass
  over its archived items; decision 21 removed that pass.)
- **The history-growth benchmark** (decisions 18, 19 and 21; mandatory). A heavy agent's whole
  list call (coordinator-opus on the converted main org) may be at most 5% slower at p95 at 10×
  inactive history than at 1×. The history is seeded inside the viewer's own subtree (retired
  descendants) and among its direct items (archived items it owns, created, reviews or takes part
  in), not only in another branch. It runs in step 3; if it fails, the prototype stops there and
  the measured numbers go to the coordinator.
- **Tree moves** (moves stay free of history). Moving a fixed live subtree, whose retired
  descendants and inactive items are seeded at 1× and 10× with distinct creator, reviewer and
  participant names inside it, must not change the move's statement count or rows read.
- **Explicit archive requests** are cold reads: their rows read are bounded by what the viewer
  may see, and they are outside the history-growth rule.

The seven `work_read_*` tables, their triggers and the per-save refresh go away. The Python
predicate stays as the test oracle.

### A.4 Mail, notices and delivery

- **`mailboxes(agent_id PK, next_recv_seq)`.** The row a delivery locks; it replaces
  `mail_archive_bounds`. `next_recv_seq` is `numeric` (CHECK at least 1 and integral), not
  bigint: a legacy ordinal is any positive integer, and conversion must keep every one. The
  row also keeps `version` and `nrows`, so the save keeps the legacy bound's compare-and-set
  (A7b-M decision 1).
- **`mail`.** One row per delivered copy (measured: no id or message id is shared between
  recipients). Columns:
  - `id`, `public_id UNIQUE`;
  - `recipient_id` → agents;
  - sender principal;
  - `kind`, `relationship`, `at`;
  - `state CHECK (queued, delivering, delivered)`;
  - `recv_seq`, `seq_origin`, `mailbox`, `message_id UNIQUE`, `operation_id`, `client_op`;
  - flags: `restart_notice`, `model_only`, `retracted`, `stale` (+ details), `redelivered`;
  - `net_id`, `reply_to json`, `ev json`;
  - `extra`, `row_version`.

  The body lives in `mail_bodies(mail_id PK, body)`. Today's unread list, `delivering` batches and
  `mail_log` archive are three states of one row: mail no longer moves between sections.
- **Indexes on `mail`:**

  | Index | Serves |
  |---|---|
  | `(recipient_id, recv_seq) WHERE state <> 'delivered'` | the inbox queue |
  | `(recipient_id, id DESC)` | the archive tail |
  | `(sender_id, at DESC, id DESC)` | Sent; replaces `mail_sent` and its trigger |
  | `(recipient_id, recv_seq DESC) WHERE recv_seq IS NOT NULL` | the next sequence number |

- **Delivery.**
  - `mail_attachments(mail_id, pos, name, path, bytes, missing)`.
  - `delivery_batches(id, tok UNIQUE, agent_id, at, via, mode, attempt, drive json, claim json, …)`
    with `delivery_batch_mail(batch_id, mail_id)`, `delivery_batch_deliveries(batch_id,
    delivery_id, role)`, `delivery_batch_notices` and `delivery_batch_segments`.
  - `mail_transition_receipts` + `mail_transition_deliveries`.
  - `manual_attempts` + `manual_attempt_mail`, `manual_chunk_calls`, `manual_chunks`.
- **Steer records.**
  - `steer_records(id, agent_id, at, level, visible_id, delivery_id, attempts, retried,
    confirmed_duplicate, fold, where_, outcome)`, with the text in `steer_texts`, plus
    `steer_record_segments`, `steer_record_mail(steer_id, mail_id)` and
    `steer_record_deliveries(steer_id, delivery_id, role)`. The chat tail index
    `(agent_id, at DESC, id DESC)` is kept (0016's shape).
  - `steer_attempts` + `steer_attempt_mail`, `steer_attempt_tokens`.
- **`notices(id, agent_id, at, text, ev json, state CHECK (pending, delivered))`.** Today's pending
  notices and `notice_log` are two states of one table. Indexes `(agent_id, id) WHERE state =
  'pending'` and `(agent_id, at DESC, id DESC)`.
- **User mail and the org inbox:**
  - `user_mail(id, public_id, sender_*, kind, at, urgent, urgent_reason, read_at, ev json)` +
    `user_mail_bodies`;
  - `user_outbox(id, recipient_id, …)` + bodies;
  - `org_inbox(id, public_id, dir, peer, by_*, at, state, state_at, net_id, message_id UNIQUE)` +
    body + `org_inbox_attachments`. The `message_id` uniqueness is what makes cross-org delivery
    idempotent (§2.7).

### A.5 Questions, audiences, watchdogs, documents, reservations

| Table | Replaces | Notes |
|---|---|---|
| `asks(id, public_id, agent_id, kind CHECK (ask, credit, scope), status CHECK, at, resolved_at, rev, reason, header, question, answer_mail, old_grant, new_grant, granted, notice)` | three doc blobs, each rewritten whole on every change | with `ask_questions`, `ask_question_options`, `ask_answer_selections`, `ask_work_items(ask_id, item_id)` (many-to-many) and `scope_request_items`. Indexes `(agent_id, status)`, `(status) WHERE status IN ('open', 'pending')`, and the resolved-recent order (0018's shape). |
| `audience_grants(grantee_id, grantor_*, granted_at, reason, delegated_by_id)` | the audiences blob | PK (grantee, grantor); index (grantor). `_has_audience` on every send becomes one key probe. |
| `audience_requests(…)` | the requests blob | |
| `watchdogs(id, public_id, owner_id, name, kind CHECK, target, pattern, interval_s, state CHECK, notice, once, at, fired, last_check, checks_run, last_output, last_exit, last_fired, paused_why, history_retained, spent_at, high_water json)` | `watchdogs` and `watchdog_tombs` | Each live dog has one `check` job. |
| `watchdog_events(watchdog_id, seq, at, gist, body)` | each dog's ring and the history log | |
| `documents(id, public_id, agent_id, at, title, format, file, bytes)` + `document_bodies(document_id PK, body)` | the presentations log | The gallery lists columns; opening a document is a key read. |
| `reservations(id, public_id, owner_id, item_id, resource, candidate, base, state CHECK, created_at, updated_at, expires_at, heartbeat_at, stale_s, integration_key, integration_receipt, landed_at, release_receipt, successor)` + `reservation_paths(reservation_id, path)` | the reservations blob (never pruned) | `UNIQUE (resource) WHERE state = 'held'`, `UNIQUE (integration_key)` |

### A.6 Logs, receipts, scheduling, feed

- **`events(id, at, op, actor_*, item_id, detail json)`**, with `event_agents(event_id, agent_id,
  role)` (many-to-many: actor, node, to, grantee, from and list members) and
  `event_warnings(event_id, pos, text)`. Index `(agent_id, event_id DESC)` on `event_agents`: the
  history panel takes 0.13–0.24 ms (74 ms today). `detail` keeps each operation's own payload (70
  distinct operations on the live copy; Q1).
- **`op_receipts(id, public_id, agent_id, gen, tool, key, fp, cls, outcome, at, mint_ms, targets
  json, result json)`** + `op_receipt_effects`. Index `(agent_id, key)`. Today's `public.receipts`
  rows for the org move here too.
- **`lifecycle(id, operation_id, kind, state, at, …)`.** Index `(operation_id, state)`.
- **The custody receipts** (0013: `receipts`, `receipt_owners`, `receipt_carriers`). Already
  relational; they move into the org database unchanged apart from the key.
- **`jobs`** (§2.7), **`changes`** and **`org_revision`** (§2.5).

### A.7 Deliberate duplicates (denormalization), with the reason for each

1. **The agent presence flags** (`is_frozen` …) beside their payload in `agent_runtime`. The hot row
   must answer "is it frozen" without reading the cold row. One function writes both in one
   statement, and a test asserts they agree.
2. **`agents.ord`.** The stable display order the product has today.
3. **`org_revision` and `changes`.** The commit log the feed needs (§2.5).
4. **`turn_tickets.agent_name`** in the app database. Copied so the admission view can show who is
   waiting without opening every org database. It is refreshed when the ticket is written.

5. **The docket's names beside its agent-row references**: `owner_name`, `reviewer_name`,
   `created_by_name`, `anchor_name`, and participants by name.
   - Today's authorization works on names, and its assignment check on agent rows (rev 5–6, f11, f17). Both
     are kept exactly.
   - A name can outlive its agent, so it is not a foreign key.
   - A rename updates both in one transaction, as today's rename updates the stored references.
6. **`docket_counters`.** The desktop's archived and backlog totals, which its header would
   otherwise compute by reading the archive (rev 5, f13). They are updated in the same transaction
   as the archive or backlog change they count, and a test compares them with a full count.

Nothing else is stored twice. (Rev 5–7 also kept two counters for agents' archived totals,
`docket_subtree_counts` and `docket_anchor_counts`; decision 21 removed those totals, and the
counters with them.)
