# Landing step 6: the record feed — design addendum (rev 3)

drag-opus, design owner, 2026-10-04. Docket: umbrella `v3-storage-keep-indexed-fields-in-real-postgresq`.
This is the "step-6 design addendum" that piece B4 waits for (remaining-pieces plan, artifact r26;
umbrella decision 23).

**Rev 2 (2026-10-04)** answers review-sol's design review of rev 1 (umbrella findings f25–f31),
and the same questions as asked by the B4 owners, before any B4 code:

| Finding | Problem in rev 1 | Rev 2 |
|---|---|---|
| f25 | A bulk rewrite with capture off left a client at the newest revision stale forever | §2.2: the rewrite makes one revision and raises the floor to it, so every older cursor resets; floor writes are monotonic (§2.4) |
| f26 (also deltas-sol) | A record that enters or leaves a set without its own write was never named | §3.3: rule M; §1.3, §4.2 and §6 "Windows" follow it |
| f27 | A subscription's partial baseline could not use the whole-stream baseline | §1.3: subscriptions answered on the socket, with sets and generations |
| f28 | The time job writes no source row, so nothing scheduled its revision | §2.3: the flush trigger sits on `changes` itself; §2.5 and §8: the time job and the prune run in B4a |
| f29 (also queue-sol) | The org list's per-org values were not versioned by the app revision | §5 rewritten: per-org summaries and notices stamped with their org's cursor |
| f30 | Lineage names were to be resolved from records the client may not hold | §1.2: bodies keep the names (R3 withdrawn); §3.2: a settings change names every held agent |
| f31 | The runtime overlay had no ordering, so a delayed baseline could restore an old value | §4.3: `(epoch, seq)` on every overlay value |

Rev 2 also moves the app feed's endpoints off `/api/orgs/`, where `GET /api/orgs/records` is the
tree of an org named "Records". It adds the app socket, which does not exist today.

**Rev 3 (2026-10-04)** answers review-sol's review of rev 2 (findings f26, reopened, f32 and f33)
and queue-sol's question on §5.2, before any B4 code. Rev 2's other mechanisms stay as reviewed.

| Finding | Problem in rev 2 | Rev 3 |
|---|---|---|
| f26 (reopened) | Rule M's ranks were read at statement time, so two writers that captured before either committed each missed the other's row: after both commits a newest-1 window could keep two entries | §2.2, §2.3, §3.3: statement-time capture reads only the statement's own rows. Every derivation that needs other rows (window ranks, pile edges, ancestor and lineage chains, name lookups) is recorded as a scope and resolved in the commit flush, after the revision row, where the state is exactly every earlier revision plus this one |
| f32 | The registry's live frames were differences from the host's last read, so a client whose HTTP baseline sat between two host reads kept a record created and deleted between them | §5.1: every registry frame is the whole registry at its revision, and the host sends one at every revision it observes. `/api/app/changes` is dropped |
| f33 (also queue-sol) | Summaries preferred "a newer incarnation", but an incarnation is a random uuid, so two cannot be ordered | §5.2: summaries and notices are host-held values ordered by the host's `(epoch, seq)`, inside an active span of their org. The org stamp stays for the identity check |

**Grounding.** This addendum was written against v3 305c472 (rev 2: 07c4dcf, which changes no
engine file; rev 3: c998e67, whose one engine change since, in `foreground_context.py`, adds the
hub identity to the tree's `net` block). It rests on two code inventories, summarized in drag-opus scratch
`step6-inventory.md`: every renderer poll of org data, and the source of every field in the tree
payload. Line numbers below are from that commit.

**References.** A bare "§N" is a section of this addendum. "Design §N" is a section of the main
design, `pg-data-model-design.md`.

## 0. The problem, and what is already settled

The desktop learns of changes through a coalesced `changed` frame that carries no change list
(`api.hub_changed`, a 0.4 s window). Each `changed` frame makes every mounted panel refetch its
whole payload through the renderer's livebus, up to about 2.5 times a second per org, and 13
panels also poll on timers of 2.5–15 s. Design §2.5 replaces this with records:

- an org database writes a change log in the committing transaction;
- the engine host turns it into frames that carry the changed records;
- the renderer applies those frames with no refetch.

Design §6.1 (the user's Q9) puts all of it in 3.2.0: "Every renderer poll is removed."

**Settled in design §2.5 and not repeated here:**
- the cursor `(org_uuid, incarnation, rev)`;
- one-snapshot baselines and catch-ups;
- "the state at R decides";
- the client rule for overlapping, old and gapped frames;
- lost NOTIFYs and reconnects;
- retention (24 h and at least 10,000 revisions, Q8);
- the desktop as the only audience (decision 17).

**Already landed on the renderer** (deltas-sol):
- `recordfeed.ts`: the ordered pipeline, gap recovery and reconnect;
- `recordtransport.ts`: `GET /api/orgs/{slug}/records` and `/changes?after=N&org_uuid=&incarnation=`. Live frames arrive on the existing org socket;
- `recordprojection.ts`: the tree from `org` and `agent` records, and an org-list projection from `registry_org` records that nothing calls yet;
- the gate `TreePayload.capabilities.record_changes_v1`.

**Not landed:** every part of the backend, records for the other panels, and the removal of the polls.

**What this addendum settles:** what a record is, given state that lives outside the database; which records each client holds; how the database captures changes; reads and frames; the panels; and how the work splits into pieces.

## 1. Records

A record is `(entity, id, body)`. **The body is a renderer value**: the JSON that today's
endpoint returns for that element, never a database row. Every body is built by the code that
builds today's payload, called for a list of ids. The rules stay in Python.

### 1.1 What a record body may contain

A body contains **only values that a revision of its feed's own database can change**. Everything
else reaches the renderer another way:

| Kind of value | Where it lives today | How it reaches the renderer |
|---|---|---|
| Rows of the org database, and values computed from them (counts, `free`, `audit`, the cost totals) | org database | **record bodies** |
| Supervisor memory: `busy`, `waiting`, `queued_for_slot`, `responding`, `phase`, `ran_as`, `queued`, `proc_*`, `mcp_*`, `tasks`, `bg_tasks`, `last_error`, `activity`, the live `codex_route`, the live `cache_forecast` | engine host memory | **runtime overlay frames** (§4.3). No database cursor: they are ordered by the host's `(epoch, seq)` |
| The app account registry: `account_label`, `account_tint_ordinal`, `serving_account`, `ran_as_label`, `continue_accounts` boards | app database, plus usage caches | **`app_runtime` frames** on the app socket (§5.3); agent bodies carry account ids only, and the renderer joins them |
| App and machine files: `prefer_reserve_default` (defaults.json), `primed_restart`, the OpenRouter favourites | files | **`app_runtime` frames** (§5.3) |
| Values read from another database than the feed's own: each org's `name`, `created`, `net_slug`, agent counts and cost total in the org list; the desktop notifications | each org's own database | per-org **summary frames** on the app socket, held by the host and ordered by its `(epoch, seq)`, each stamped with its org's identity and revision (§5.2) |
| Values that depend on the clock: the resolved-ask window (15 min), watchdog tombs (15 s), docket deadlines and attention, freeze deadlines, fable-lock expiry | computed at read time | record bodies, kept correct by **time-boundary revisions** (§2.5) |

### 1.2 Entities and ids

- `org`: the org's top-level values, split into **groups** with id = group name, because they change at different rates (§3.1). This changes the landed projection, which reads one record with id `org`: it must merge every `org` record (renderer change R1).
- `agent`: id = `agents.id` as text.
  - The body is today's tree node for that agent, minus the overlay fields of §1.1, plus `parent_id` (an id, not a name) and the sibling order keys `ui_order`, `created`, `ord`, `name`.
  - The renderer sorts siblings by exactly that tuple, the backend's order. Today `recordprojection.ts` uses `sibling_order ?? ui_order`, then the record id, and nothing produces `sibling_order` (renderer change R2).
  - The lineage fields stay as today's tree node has them: the `predecessor` and `successor` names, `lineage_count` and `consultable_predecessor`. A predecessor can be outside every set the client holds (an archived agent off the org axis), so a body must not point at a record the client may lack. A rename therefore also dirties the renamed agent's predecessor and successor records (§3.2). Rev 1's renderer change R3 (ids instead of names) is withdrawn.
- Panel entities: §6.
- `registry_org`, and app-wide entities: §5.

### 1.3 Which records a client holds

**The shared set**, the same for every socket of the org. It is decided in the same snapshot as the bodies:
- the `org` groups;
- the agents that `foreground_store.select_foreground` returns with an **empty** include list and `piles=1`: every non-archived agent, the representatives of each retired pile, and their ancestors;
- the org-level panel windows (§6).

**Subscriptions**, per socket. These cover:
- per-agent panels: an agent's history, its mailbox;
- agents outside the shared set that the client has open, such as pinned archived agents (today's `include` ids, at most 128). Each subscribed agent brings its ancestors, as `include` does today.

**Sets.**
- Every record a socket holds belongs to one or more sets: `shared`, and `sub:<g>` for each subscription.
- Each upsert and tombstone in a frame names its set (`set`, default `shared`).
- The client keeps each set's members. A record leaves the store when no set holds it.
- Bodies do not depend on the set.

**Subscribing.**
- The client sends `{type: 'subscribe', sub: g, windows: [...], agents: [...]}` on the socket. g grows with each subscription on that socket.
- **The answer** comes on the same socket, in order with the frames: `{type: 'record_subscribed', sub: g, org_uuid, incarnation, rev, records}`.
  - The host's per-org runner (§4.3) reads it in the same snapshot as the catch-up that brings its cursor to `rev`, and queues it right after that frame.
  - A subscription made while nothing changes is answered at once at the current revision. No commit is needed.
- **The client merges an answer** only when g is still pending and `rev` equals its cursor. Otherwise it discards the answer and subscribes again with a new generation. That happens only when an HTTP catch-up has moved its cursor past `rev`.

**Unsubscribing:** `{type: 'unsubscribe', sub: g}`. The client drops set `sub:g` at once, and ignores anything that names it later. The host stops computing it.

**HTTP reads.**
- An HTTP catch-up names the active subscriptions (generation, windows, agents) beside `after=N`, and its answer labels each entry with its set.
- `/records` returns the shared set only. After a reconnect, the client subscribes again on the new socket.
- `record_reset` drops every set. The client takes a new baseline and subscribes again.

**A tombstone means "not in the set it names, at R"**, whether the record was deleted or left the set; an archived agent, for example, leaves the shared set. A record that changed while outside the set produces nothing.

A record can also enter or leave the set because ANOTHER record was written: an insert pushes the oldest entry out of a window, for example. The write that caused it names it in its capture (§3.3, rule M). So a catch-up never needs to know which records the client held.

## 2. Capturing changes in the org database

### 2.1 Tables

```sql
CREATE TABLE orgtree.changes (       -- written by statement triggers, insert-only
  xid        xid8 NOT NULL,          -- the writing transaction (pg_current_xact_id())
  entity     text NOT NULL,
  entity_id  text NOT NULL,
  PRIMARY KEY (xid, entity, entity_id)
);
CREATE TABLE orgtree.revisions (     -- one row per committing transaction that changed records
  rev  bigint PRIMARY KEY,
  xid  xid8 NOT NULL UNIQUE,
  at   timestamptz NOT NULL
);
ALTER TABLE orgtree.org_revision ADD COLUMN floor bigint NOT NULL DEFAULT 0;
```

This refines design §2.5's single `changes(rev, pos, entity, entity_id, op)`. The revision is known only at commit, but the changed records are known statement by statement. So the statement triggers write `changes` keyed by the transaction's id, and the commit writes one `revisions` row that maps the transaction to its revision.
- Both tables are insert-only: no update and no temporary table.
- A rollback, including to a savepoint, removes the rows it inserted.
- Rows of a transaction that never commits are never visible.
- `op` and `pos` are dropped, because the state at R decides (design §2.5).

### 2.2 Statement-time capture

Every table that feeds a record gets AFTER INSERT, UPDATE and DELETE triggers FOR EACH STATEMENT, with transition tables, as org migration 0006 already does for its counters. They insert:

```sql
INSERT INTO orgtree.changes (xid, entity, entity_id)
SELECT DISTINCT pg_current_xact_id(), e.entity, e.entity_id
FROM (<derivation over old_rows and new_rows>) e
ON CONFLICT DO NOTHING
```

Each table's derivation is its entry in the derivation map (§3).
- **Both OLD and NEW rows count.** A row that moved from one agent to another dirties both.
- **Statement time reads only the statement's own rows** (rev 3, finding f26).
  - A derivation computed here reads the transition tables and nothing else.
  - A derivation that needs any other row records a **scope** instead: a change row with entity `~scope` and id `<kind>:<key>`, such as `window:agent_history:42`, `pile:17:803`, `chain:17`, `lineage:23` or `name:bob` (§3.3). It also raises a transaction-local count, `orgtree.pending_scopes`, as 0006's triggers raise theirs.
  - The commit flush resolves the scopes against the state at its revision (§2.3).
  - Why: a read here sees neither the uncommitted rows of a concurrent writer nor the rows that writer commits later, and the two commits can happen in either order.
- **Lock order** (decision 26, design §2.4 as amended by B5). These triggers insert rows of their own transaction only. They take no row lock and never touch `org_revision`. Decision 26's list of statement-time writes gains `changes`; `tests/test_orgdb_lock_order.py` gains it.
- **Cost** is one INSERT … SELECT DISTINCT per statement, bounded by the statement's own rows.
- **Bulk writers turn capture off, and invalidate every cursor instead.**
  - The converter filling a new org database, and a migration that rewrites data in place (for example the G1–G11 backfill), run with capture off: a transaction-local setting, `orgtree.capture = off`, that the capture triggers check.
  - A writer that rewrites an existing database calls `orgtree.invalidate_cursors()` once in that transaction. It inserts one change row (entity `reset`) and marks the transaction. The flush (§2.3) then makes the transaction's revision R+1 as usual, with its NOTIFY, and also raises `floor` to R+1.
  - Every cursor from before the rewrite is then below the floor. Its catch-up answers `record_reset`, even for a client that was at the newest revision R, instead of receiving one revision that names every record.
  - The NOTIFY wakes the live sockets. The host's catch-up from its cursor meets the floor and sends `record_reset`; no later data commit is needed.
  - A catch-up in a snapshot taken before the commit answers as of that snapshot, and the next one resets.
  - A new database starts at revision 0 with no change rows. Its new identity resets every older cursor.

### 2.3 The commit flush: the single place a revision is made

**The flush is a deferred constraint trigger on `orgtree.changes` itself** (row-level, DEFERRABLE INITIALLY DEFERRED, as in the 0006 pattern).
- So every transaction that inserts a change row queues it: capture (§2.2), the time-boundary job (§2.5) and `invalidate_cursors` (§2.2) alike.
- A rollback, including to a savepoint, discards the rows and their queued events together.
- Its first firing in a transaction is marked by a transaction-local setting. A later firing returns at once, unless `orgtree.pending_scopes` is above zero: then it resolves the new scopes and returns. Nothing forces a deferred check in the middle of a transaction (design rev 7.5); this keeps one correct anyway.

That first firing runs:

```sql
IF EXISTS (SELECT 1 FROM orgtree.changes WHERE xid = pg_current_xact_id()) THEN
  UPDATE orgtree.org_revision                                          -- the revision row, last
     SET rev = rev + 1,
         floor = CASE WHEN <this transaction called invalidate_cursors>
                      THEN GREATEST(floor, rev + 1) ELSE floor END
   RETURNING rev INTO r;
  PERFORM orgtree.resolve_scopes();        -- names what each scope reaches at r (§3.3)
  INSERT INTO orgtree.revisions (rev, xid, at) VALUES (r, pg_current_xact_id(), now());
  PERFORM pg_notify('org_rev', (SELECT slug FROM orgtree.org_identity) || ':' || r);
END IF;
```

- **This is the only place a revision is made, with the switch on.**
  - `OrgDbConn.on_save_commit` stops bumping `rev`; it keeps `docket_finish`.
  - jobs.py's rule that "handler authors must bump org_revision" is removed.

  So every writer gets its revision whether it is a save through the compatibility view, a native writer, a job or a migration-time backfill. Revisions have no gaps, because the revision row serializes them in commit order. A transaction that inserted no change row makes no revision, as today's `changed=False`.
- **The NOTIFY payload `'<slug>:<rev>'` is unchanged**, so `pgfeed` keeps parsing it.
- **The existing counters** (`node_rev`, `catalog_rev`, `view_rev`, `docket_rev`, `events_count`, the cost sums, `foreground_parent_counts`, `docket_counters`) keep their own flushes. They stay as cache stamps for the readers that use them. Records that show derived values are dirtied by their source tables (§3), never by the derived row.
- **Local-revision bookkeeping retires.** `pgfeed.begin_local`, `confirm_local` and `abort_local` exist so a process does not refetch its own commit. Record frames reach every client from the host cursor, whoever committed, so with the switch on this bookkeeping retires with the `changed` broadcast.

**Scopes are resolved here, after the revision row** (rev 3, finding f26).
- **Commits that make a revision run one at a time.** At commit, every writer takes the revision row before any other commit-time lock: this flush, and every counter flush of migrations 0006 to 0012, each of which updates or locks the revision row before any counter key (decision 26: the revision row first, then counter keys). A second committer waits on the row until the first has committed.
- **The resolution sees exactly the state at r.** Writers run in READ COMMITTED: the compatibility view's `BEGIN IMMEDIATE`, native writers and jobs alike. `resolve_scopes` is a VOLATILE plpgsql function, so each of its statements takes a fresh snapshot, taken after the revision row. That snapshot holds every earlier revision and this transaction's own rows, and nothing else that changes records: no other revision can commit while this transaction holds the row. So its names are exact for r, whatever ran concurrently.
- **A REPEATABLE READ or SERIALIZABLE writer cannot resolve against an older state either.** If another revision committed after its snapshot began, its UPDATE of the revision row fails with a serialization error, and nothing it wrote commits.
- **The lock order (design §2.4, rules 4 and 5).** After the revision row the flush writes only rows that no other transaction can hold: its own `changes` rows, keyed by its own xid, and its `revisions` row, keyed by r, which only the holder of the revision row can write. They join `foreground_parent_counts` and `docket_counters` as rows under the revision row. `resolve_scopes` is called only by the flush and counts as part of it. Its reads of other rows take no lock. So a transaction holding the revision row still waits for nothing else, and `tests/test_orgdb_lock_order.py` lists the two tables under the revision row.
- **Nothing captures after the resolution.** Design §2.4 already allows a deferred trigger to write only the revision row and the rows under it, and none of those feeds a record: 0006, 0007, 0008, 0010 and 0012 write counter rows and `org_revision`'s own columns. The map's static test (§3) checks it again for every deferred trigger.
- **Cost.** One bounded read per scope, while the revision row is held: an index-ordered read of at most K+m entries per window partition, 2(n+1) children per pile, and one walk up the tree per chain.

### 2.4 Retention

A per-org prune job, on the jobs framework (B3), runs in one transaction:
1. pick the new floor F: the highest revision that is both older than 24 h and at least 10,000 revisions below the newest;
2. delete `changes` rows whose `xid` belongs to a `revisions` row below F;
3. delete those `revisions` rows;
4. set `org_revision.floor = GREATEST(floor, F)`. The floor never goes down, so a prune that chose F before a bulk rewrite raised the floor (§2.2) cannot lower it.

The job takes the revision row last. A catch-up snapshot sees either the old rows with the old floor, or the new floor and answers `record_reset` (design §2.5's race-free boundary). Until B3 runs jobs in the host, a host timer runs the same transaction, from B4a on.

### 2.5 Time-boundary revisions

Some displayed values change when a time passes, with no write: the resolved-ask window (15 min), watchdog tombs (15 s), docket deadlines and the attention they raise, freeze deadlines, and fable-lock expiry. A per-org job keeps them correct:
- it computes the next boundary over those tables (`min(resolved_at + 15 min, tomb.at + 15 s, deadline, frozen.until, …)`);
- it sleeps until then;
- in one transaction, it inserts `changes` rows for the records whose displayed value crosses the boundary, which makes a revision through the normal flush.

So clients see time-based changes as ordinary revisions. The rules stay in Python, and no renderer code reproduces them. A write that changes a boundary (a new ask, a new deadline) re-arms the job.

**Staging.** The tree's records already show these values: the resolved-ask window, watchdog tombs, freeze deadlines and fable-lock expiry. B4a removes the tree's poll, so B4a builds this job. Until B3 runs jobs in the host, a host timer runs it, as for the prune (§2.4). B4d then moves both onto the jobs framework.

## 3. The derivation map: which records a table's rows dirty

The map is per table, and it lives beside the migrations as one SQL function per table, generated from a single Python table of `table -> derivation`.
- A static test fails when an org table is neither in the map nor listed as feeding no record (with a reason).
- A piece that adds or reshapes a table updates its entry in the same commit. That includes B1, B2 and the G1–G11 conformance piece.
- Name-keyed references are resolved to agent ids against non-deleted agents (`asks.node`, `documents.node`, `audience_grants.grantee`, `notice_log.node`, `watchdogs.owner`, `reservations.owner`). The lookup reads `agents`, so capture records the scope `name:<name>`, and the flush names the agent holding that name at r (§3.3).
- A static test fails when a deferred trigger writes a table that feeds a record (§2.3).

### 3.1 The `org` groups

| Group | Contents (today's tree header fields) | Dirtied by |
|---|---|---|
| `settings` | slug, name, workspace, dirs, grants/compaction settings, default_tools / visibility / account / effort, permission_mode, fable_*, killswitch, auto_cheap_compact, account_fallback_default, auto_resume*, cascade_*, headless, effort_default | `org_settings` (those columns), `org_dirs` |
| `tiers` | tiers, models | `org_tier_prices`, `org_tier_models` (the app-level favourites arrive by the app feed, §5) |
| `cost` | cost_usd_total, cost_usd_unknown, api_cost_usd_total | `agents` (cost columns), `org_settings` (deleted_cost_*, api_cost_usd) |
| `audit` | audit | `agents` (parent, state, model, grant), `org_tier_*` |
| `foreground` | hidden_retired_roots, retired_total, catalog_revision | `agents` (state, successor, parent, name) |
| `asks` | asks, asks_open, credit_requests | `asks`, `credit_requests`, `scope_requests` and their children |
| `audiences` | audiences, audience_requests | `audience_grants`, `audience_requests` |
| `watchdogs` | watchdogs | `watchdogs`, `watchdog_events`, `watchdog_tombs` (+ time boundary) |
| `inbox_summary` | user_inbox_count, urgent_unread, user_inbox_newest | `user_inbox` |
| `org_inbox` | org_inbox entries / total / unread / holders / multi_holder / visible | `org_inbox`, `org_settings` (org_inbox_read), `audience_grants`, `agents` (state of holders) |
| `net` | net (static part) | `org_settings` (net_identity, net_spool), `net_hubs`, `net_state`. Live hub connectivity is a runtime overlay (§4.3) |
| `work_summary` | work_items_summary | `work_items`, `docket_question_links`, `docket_counters`' sources (+ time boundary) |

### 3.2 `agent` records

| Source | Dirties |
|---|---|
| `agents` (any column) | `agent(id)` |
| `agents` (parent, state, model, credit_grant): `free` | `agent(old parent)`, `agent(new parent)` |
| `agents` (state, successor, parent): pile counts | `agent(old parent)`, `agent(new parent)` |
| `agents` (name, state, bearer_state, generation, predecessor, successor): lineage | `agent(predecessor)` and `agent(successor)` on the old and the new links, because their bodies show this agent's name; and, through the scope `lineage:<id>` resolved at r (§3.3), the successors while `lineage_count` reads them |
| `agent_texts`, `agent_runtime`, `agent_turns` (recent members), `agent_recent_turns` (until G7 merges it), `agent_tool_denials`, `agent_tool_approvals`, `agent_mcp_servers`, `agent_dir_grants`, `agent_carriers` (+ links), `tool_list_items` of its list | `agent(agent_id)` |
| `mail` (the pending count) | `agent(agent_id)` |
| `audience_grants` (grantee) | `agent(grantee)` (audiences_held) |
| `asks`, `credit_requests`, `scope_requests` (node) | `agent(node)` (`ask`) |
| `documents` (node) | `agent(node)` (newest 10 + count) |
| `org_settings` (tiers / models via `org_tier_*`, default_effort, killswitch, fable_lock, auto_cheap_compact, account_fallback_default, permission_mode) | **every agent record a socket holds.** Capture names the wildcard `(agent, *)`, and a catch-up expands it to every agent in the caller's sets: the shared set and each subscription. These are rare writes; above the frame bound the answer is `record_reset` |

**Required backend change B-1.** The foreground `detail_rev` of an archived agent mixes in the global `catalog_rev` (`foreground_view.py:79-81`), so any hire, rename or move would dirty every archived record. A record's `detail_rev` must depend only on that agent's own rows and its lineage: its `row_version`, plus its predecessor chain's.

### 3.3 Membership changes (rule M)

A record can enter or leave a set while its own rows are unchanged:
- an insert pushes the oldest entry out of a newest-K window;
- an older child, archived later, displaces a pile's first representative;
- an agent entering the set brings its archived ancestors in.

The catch-up (§4.2) reads only the captured `(entity, id)` pairs and the state at R. Neither an HTTP catch-up nor a reconnect knows which records the client held at N. So:

**Rule M.** Capture names every record whose body OR membership can change, on both sides: the records that leave a set and the records that enter it, even when their own rows are unchanged. "Capture" here is both halves: the statement-time names and the flush's resolution of scopes.
- A record that capture does not name is unchanged between N and R, in body and in membership.
- The protocol never carries or keeps a client's member ids. HTTP catch-ups and live frames run the same stateless query.
- Naming more records than needed is harmless, because the state at R decides. Naming fewer is a bug, which the equality tests of §7 catch.

How each kind of set meets rule M. Each set is declared once in the derivation map, and both the trigger SQL and the scope resolver are generated from the declaration. Statement-time capture names the rows the statement wrote; everything that depends on other rows is a scope, resolved by the flush at the transaction's revision r (§2.2, §2.3).
- **Predicate sets.** Membership depends only on the record's own rows, or on rows whose derivation already names it: non-archived agents, open asks, pending inbox entries, active docket items. Statement-time capture names them. Nothing beyond §3.1–3.2 is needed.
- **Newest-K windows.**
  - Declared as (stream, partition, immutable order key, K, membership predicate). A stream may be a union of tables: an agent's history is its event refs plus its notices.
  - At statement time, capture names the entries the statement inserted, deleted or changed (a predicate change included) under the window's name (for example `agent_history:<agent id>`), and records the scope `window:<window>:<partition>`. A catch-up can then route a tombstone to the sockets that hold that window, even when the row is gone at R.
  - The flush resolves the scope. With m the number of that partition's entries the transaction's statements named, it names the entries at ranks K−m+1 … K+m of the partition at r: one index-ordered read per touched partition.
  - Why that range is enough. Ranks count from the newest entry, which is rank 1. Between r−1 and r only this transaction's rows changed (§2.3). It added at most m entries to the partition and removed at most m. An entry it did not touch keeps its order key, so its rank moves by at most m. An untouched entry that left the window had a rank of at most K at r−1, so its rank at r is in K+1 … K+m. One that entered had a rank above K at r−1, so its rank at r is in K−m+1 … K.
  - K is part of the declaration. The renderer shows the records it receives, and has no K of its own.
- **Pile representatives.** These are the first and last retired child of each visible pile, in the sibling order of §1.2: a window with K = 1 from each end.
  - A statement might touch retired children of parent P (an archive, an unarchive, a move in or out, or a change to a successor or a sibling key), or change P's own membership. Capture names what it wrote and records the scope `pile:<P>:<child id>` for each child it touched (`pile:<P>:-` for P's own membership).
  - The flush, with n the number of those scope rows for P, names the first n+1 and the last n+1 retired children of P at r.
  - By the window argument, that covers an old edge that a new edge displaced, and the next edge exposed when an edge left.
- **Ancestors.** A statement that changes an agent's membership or its parent records the scopes `chain:<old parent>` and `chain:<new parent>`, from its OLD and NEW rows. The flush walks up from each at r, and names the archived ancestors it passes.
  - Why at r: between r−1 and r, a chain changes only by this transaction's own parent changes, which record their own starts. So the walks at r reach every ancestor whose membership this revision changes, including over a parent move that another writer committed first.
- **Lineage chains and name lookups** (§3, §3.2) are resolved at r the same way: `lineage:<id>` names the successors that `lineage_count` reads, and `name:<name>` names the non-deleted agent that holds the name at r.
- **Time boundaries** (§2.5). The job names the records whose membership crosses the boundary, as it does for bodies. Its reads need no scope: the boundary depends only on the clock and the rows it reads, and a concurrent writer that changes those rows names the same records in its own capture. The state at R decides.

**Concurrent writers (finding f26).** Take a newest-1 window holding A (order key 1) at revision 10. Transactions T_B and T_C insert B (key 2) and C (key 3), and both finish their statements before either commits.
- Rev 2 read the ranks at statement time. T_B saw A and B, T_C saw A and C. B committed as 11 naming B and A, C as 12 naming C and A. A catch-up from 11 then upserted C and tombstoned A, and the client kept B.
- Rev 3: T_B's flush takes the revision row and resolves at 11, over A and B: m = 1, ranks 1 … 2, so it names B and A. T_C's flush waits on the revision row until T_B has committed, then resolves at 12, over A, B and C: ranks 1 … 2 are C and B.
  - A client at 11 holds B. It receives an upsert of C and a tombstone of B.
  - A client at 10 holds A. It receives the union of 11 and 12: an upsert of C, tombstones of A and B.
  - Both equal a fresh baseline at 12. In the other commit order, 11 names C and A, and 12 names C and B, with the same result.
- Piles, ancestors, lineage and names follow the same argument: each is resolved against the state at its own revision, so the writer that commits second always sees the one that committed first.

## 4. Reads and frames

### 4.1 `GET /api/orgs/{slug}/records`

One REPEATABLE READ READ ONLY transaction:
- `org_identity`;
- `org_revision.rev` = R;
- every record of the shared set. Subscriptions are made on the socket (§1.3).

It answers `{type: 'record_snapshot', cursor, records}`, plus `runtime` (§4.3) beside the cursor and not under it. Every body builder takes the snapshot connection explicitly; inside the snapshot, nothing checks a connection out of a pool. Exporting a snapshot (`pg_export_snapshot()`, then `SET TRANSACTION SNAPSHOT` in a builder's own transaction) is also acceptable.

### 4.2 `GET /api/orgs/{slug}/changes?after=N&org_uuid=&incarnation=[&subs=…]`

One snapshot.
- Another identity, `N < floor`, or `N > R`: answer `record_reset`.
- `N = R`: answer an empty `record_changes`.
- Otherwise:
  1. read the distinct `(entity, id)` from `revisions r JOIN changes c USING (xid) WHERE r.rev > N AND r.rev <= R`, skipping the `~scope` rows, which name no record (their resolution is already among the rows);
  2. keep those whose set the caller holds (the shared set, and the subscriptions named), whether or not they are members at R. A wildcard `(agent, *)` expands to every agent in those sets;
  3. decide each one's membership at R (rule M, §3.3). A member is an upsert, with its body built in batches per entity, by id, in the same snapshot. A non-member is a tombstone, which is harmless if the client never held it;
  4. answer `record_changes {from: N, to: R, upserts, tombstones}`.
- Above a bound on distinct records (a constant, starting at 2,000), answer `record_reset`.

### 4.3 Live frames and the runtime overlay

**Record frames.**
- The host keeps a server cursor per org that has open sockets.
- On a NOTIFY on that org's per-org LISTEN session (`pgfeed.orgdb_conn`), it runs the catch-up of §4.2 from that cursor, once for the shared set and once for each socket's subscriptions.
- It sends each socket its `record_changes` frame, each entry labelled with its set (§1.3), and advances the cursor.
- One catch-up runs at a time per org; a NOTIFY during a run marks the org dirty, and the run repeats.
- New subscriptions are answered in the same run, from the same snapshot (§1.3). A run starts when a subscription arrives, too.
- pgfeed's poll and reconnect read (a lost NOTIFY) run the same catch-up.
- A frame above the per-socket queue limit becomes `record_reset`.

**The runtime overlay.** When a socket's capability is on, the host sends `{type: 'agent_runtime', org_uuid, incarnation, epoch, seq, agents: {id: {…the §1.1 overlay fields…}}}` on every change of an agent's runtime state, from the supervisor's own transitions.
- **Ordering.** Every overlay value carries the host's `(epoch, seq)`.
  - `epoch` names the engine host's run; it is new at each start.
  - `seq` grows with every overlay change in that run. The host has one such counter per run, shared by every value it orders this way: this overlay, and the app socket's summaries, notices and `app_runtime` values (§5).
  - The client keeps, per agent, the value with the highest `seq`.
- **Full copies.** The socket's first frame on connect is the full overlay: a complete map at its `seq` s, which also sets the client's epoch. `/records` carries a full overlay too.
  - A full overlay replaces an agent's value only if s is higher than that value's `seq`.
  - It removes an agent it lacks only if that agent's value is older than s.
  - So a delayed baseline cannot restore an older value.
- **Identity.** Values of another epoch than the socket's, or of another org identity (`org_uuid`, `incarnation`), are ignored.
- No database cursor is involved: the overlay is engine memory, and a host restart starts a new epoch.
- Today's `node_stream` and `node_event` frames stay as they are.
- The live hub connectivity in the `net` group's display is an overlay field too.

### 4.4 With the capability on, the old protocol goes

The `changed` frame, the frame `rev` and `sync_rev`, the 0.4 s coalescing and the livebus refetch on `changed` are not used for an org whose socket has the capability on.
- The capability is set only when the org database has the change-log migration and the storage switch is on.
- With the switch off, everything stays as today.

## 5. The app socket and the app feed

**Today there is no app-level socket.** The engine serves only `/api/orgs/{slug}/ws`. The org list, the app-wide values and the Electron main process's notifications are all polled.

**B4b adds:**
- the app socket `/api/app/ws`;
- its HTTP read `/api/app/records`. Rev 2's `/api/app/changes` is dropped (§5.1).

They are not under `/api/orgs/`: there, `GET /api/orgs/records` is the tree of an org named "Records" (`GET /api/orgs/{slug}`, api.py:2344).

**The org list has three sources** (today's `/api/orgs` row: `orgs_list` and `_orgdb_org_row_read` in api.py):
- the app database's registry;
- each org's own database;
- engine memory.

So the app socket carries a different kind of content for each.

### 5.1 The registry: the app database's own feed

- **Records.** `registry_org`, with id = `org_id`.
  - The body is the registry's part of today's row: `org_id`, `slug`, `org_uuid`, `state`, `unavailable_step`, `state_reason`, `attempts`, `report_path`.
  - It holds nothing from an org database.
- **Identity.** B4b's app migration adds an identity row for the app database: `app_identity(app_uuid, incarnation)`.
  - The row is made when the app database is created.
  - Any tool that restores or replaces the app database bumps `incarnation`. Every such tool runs with the engine stopped: it holds the data root's owner lock, as `restore-org.py` and `pgimport import` do. So a new app identity always comes with a new host epoch (§4.3).
- **Revision.** A `registry_revision` row.
  - A transaction that writes `orgs` raises it by one, in a deferred flush that locks the revision row last.
  - The flush sends `NOTIFY app_rev '<rev>'`.
  - B4b checks every writer of `orgs` (the lifecycle and registry code) for that lock order, and covers it with a static test, as decision 26's test does for org databases.
  - The existing per-row `NOTIFY app_orgs` stays. Nothing listens to it today.
- **Cursor.** `(app_uuid, incarnation, rev)`.
- **Every registry frame is the whole registry** (rev 3, finding f32).
  - The registry holds one row per org: a few dozen rows at most. So no frame is a difference. Each one is `{type: 'registry_snapshot', epoch, cursor, records}`: every `registry_org` record, read in one app-database snapshot together with `rev`.
  - The host refreshes on every revision it observes, through the coalesced one-at-a-time runner (§5.4). Each run reads the newest revision and sends its snapshot whenever that revision is newer than the last one sent. It never skips a snapshot because the records equal its own last frame, so no client's state depends on which revisions the host happened to read: an org created at 11 and deleted at 12 leaves no trace in any client after the snapshot at 12.
  - The client applies a snapshot only if its `rev` is higher than the client's own, and then replaces all its `registry_org` records with it. A snapshot at or below the client's `rev` is dropped. So a delayed snapshot changes nothing, and nothing is ever applied over a state it was not computed from.
  - Snapshots of another epoch than the client's socket are dropped (§4.3). A snapshot of another app identity within the socket's epoch makes the client drop its app records and reconnect.
  - The host's app LISTEN session follows pgfeed's rules for a lost NOTIFY: a periodic read of `registry_revision`, and a read on every reconnect, run the same refresh.
- **HTTP.** `GET /api/app/records` answers the same full copy as the socket's first frame, taken under one lock: the host's last registry snapshot, the summaries and notices (§5.2) and the `app_runtime` values (§5.3), all with the host's epoch. There is no catch-up endpoint: a client that may have missed frames reads `/api/app/records`, or reconnects.
- **No change log.** The app database needs no `changes`, `revisions` or floor.

### 5.2 Org summaries and notices: held and ordered by the host

**The problem.** Today's row also shows values read from each org's own database: `name`, `created`, `net_slug`, `nodes`, `live` and `cost_usd_total`.
- An app-database snapshot cannot freeze them.
- A registry revision does not change when they do.
- Copying them into the app database would break design §2.10's rule that it holds only what cannot live in an org's own database. It would also add an app-database write for every org commit.

So the host holds them, one entry per active org, and orders them itself (rev 3, finding f33).

**Why not the org's cursor.** An org's cursor orders the revisions of one org database. A database that replaces it (a Retry's rebuild, an import) gets a new incarnation, which is a random uuid (`lifecycle._write_identity`), so two incarnations cannot be compared to find the newer one. An HTTP answer and the socket share no order either. The host's own `(epoch, seq)` orders them instead, as it orders the runtime overlay (§4.3).

- **The frame.** `{type: 'org_summary', org_id, epoch, seq, org_uuid, incarnation, rev, body}`.
  - The body is those six values. `body: null` removes the org's entry.
  - They are read in ONE snapshot of that org, together with its identity and `rev`, by today's code: `org_summary._read`, or `_orgdb_org_row_complete` for an org on the compatibility path.
  - The stamp `(org_uuid, incarnation, rev)` is for the identity check below, for tests and for diagnosis. The client orders entries by `seq` only.
- **Active spans.** An org has an entry only while it is active.
  - A span starts when the host's registry refresh (§5.1) sees the org enter `active`, and ends when it sees the org leave `active` or disappear.
  - Source inspection at c998e67: a database that replaces an org's database, with a new incarnation, is built and published only while the org's registry row is not `active` (`lifecycle._prepare`, then `publish`, from create, convert, retry and import claims). The offline tools that replace or restore databases (`restore-org.py`, `pgimport import`) run only while the engine is stopped, so a new epoch follows them. A trash and a restore keep the same database and its incarnation.
  - So every change of incarnation falls between two spans.
  - If a replacement were ever published while the row stayed `active`, two things still hold. The identity comparison below sends the new identity. And reads stay in order, because `publish` renames the new database onto the final name, which the old one must have left first.
- **When it is read.** The host reads an org's summary when a span starts, and after every revision of the org that its revision feed observes.
  - That feed already holds a LISTEN session for every active org (`pgfeed.orgdb_conn`). So it sees local commits, other processes' commits and gaps alike.
  - The reads run in the org's runner, the fill at start included: one at a time per org. A revision during a read marks the org dirty, and the read repeats after it, at most once a second per org.
  - A read starts only inside a span, and records which span. Its result is stored only if that span is still current when the read ends. So a read that began before a replacement is never stored after it.
- **When a frame is sent.** Each change of an entry takes the next `seq` from the host's counter (§4.3) and sends one frame:
  - the first read of a span. It always sends, because the previous span's entry was removed. So a replaced database with six equal values still sends its new identity;
  - a later read whose `org_uuid`, `incarnation` or body differs from the entry. A new `rev` alone sends nothing;
  - the end of a span, as the removal `body: null`. The host queues it before the registry snapshot that shows the org leaving `active`. When a span starts, the registry snapshot goes first and the summary follows its read.
- **Full copies.** `/api/app/records` and the first frame of every app-socket connection carry every entry, with the host's `epoch` and the copy's `seq` s. The host assigns a `seq`, stores the entry and takes a copy under one lock, so a copy at s holds exactly the entries as they stood at s.
- **The client rule** is the overlay's (§4.3), per org:
  - it keeps the entry with the highest `seq` of its socket's epoch. A removal is an entry too, and keeps its `seq`;
  - a full copy replaces an org's entry only if s is higher than that entry's `seq`, and removes an entry it lacks only if that entry's `seq` is below s;
  - values of another epoch are dropped. The first full copy of a new epoch replaces every entry;
  - so a delayed copy cannot bring back an older entry. In queue-sol's example the socket's summary of the new incarnation (B, `rev` 1) has a higher `seq` than any copy that holds the old one (A, `rev` 99): the host stored B after it removed A, so every copy taken while A was current has a lower s.
- **What the list shows.** An org's summary is shown when its `registry_org` record is `active` and has the same `org_uuid`. The client never compares incarnations. In the moment after a span starts, before the summary arrives, the row shows what today's complete reader shows for an org without its database values (`_orgdb_org_row_complete`: the slug as the name, zero counts and cost).
- **Unavailable orgs.** An unavailable org has no entry. The list shows its registry record, the Retry-only row, as today.

**Desktop notifications** (`/api/desktop/notifications`, polled every 5 s by the Electron main process) take the same form: `{type: 'org_notices', org_id, epoch, seq, org_uuid, incarnation, rev, notices}`.
- The host builds them per org with today's builder (asks, user_inbox, work_items, documents, frozen agents), in the same read as the summary, with the same spans.
- `notices` is the org's whole current notice set at that revision, not a delta. So a lost frame is healed by the next one, and a reconnect brings every org's set.
- The same `seq` and client rules as for summaries apply: a removal ends a span, and a delayed full copy cannot bring back the notices of a replaced database.
- The main process subscribes on the app socket. It keeps its rule against repeating a notification it has already shown.

### 5.3 Engine memory and app-wide values

- **`working`** (the agents with a running turn, in supervisor memory) is an app-level runtime overlay: `{type: 'app_runtime', epoch, seq, orgs: {org_id: {working}}}`. It is sent on change, and complete on connect.
- **App-wide values polled today** are pushed by the host timers that already read them (decision D7): provider usage and peeks, providers, the account registry, login status, `prefer_reserve_default`, `primed_restart`, and the OpenRouter favourites. They arrive as `app_runtime` frames, and a full copy comes on connect.
- Every `app_runtime` value follows the overlay's `(epoch, seq)` rule (§4.3), so a delayed copy cannot restore an older value.

### 5.4 What B4b takes from B4a

- **A revision subscriber list.** The host's revision feed calls every subscriber with `(slug, rev, gap)`, for every revision it observes of every active org, local commits included. B4a's record catch-up is one subscriber; B4b's summary and notice refresh is another.
- **The frame machinery,** kept independent of the org socket: per-socket queues, an oversize frame becoming `record_reset`, and the coalesced one-run-at-a-time runner. The app socket reuses it: on the app socket, an oversize queue closes the socket, and the client reconnects for a full copy.
- **The host's `(epoch, seq)` counter** (§4.3), one per host run. B4b's summaries, notices and `app_runtime` values draw from it.

**The renderer's org list** is `projectOrgs` over `registry_org` records (landed). It is joined by `org_id` with the summaries and the `working` overlay into today's `OrgListEntry`.

## 6. The panels: records instead of polls

| # | Panel (poll today) | Records |
|---|---|---|
| 1 | Tree (6 s heartbeat + `changed`) | `org` groups + shared `agent` records + overlay |
| 2 | Org list (3 s) | app socket: `registry_org` records, per-org `org_summary` frames and the `working` overlay (§5) |
| 3/4 | User inbox, attention queue (5 s) | shared windows: `user_inbox` (all pending; a state set), `user_mail_log` (newest 50), `user_outbox` (newest 50) |
| 5 | Audiences (5 s) | the `org` group `audiences`, which also stops its whole-org load |
| 6 | Events (5 s) | shared window `event` (newest 300) + the `org` group `events_count`. Search stays a cold read |
| 7 | Agent history (5 s) | subscribed window `agent_history:<id>` (newest 80 events by `event_refs` + notices by node) |
| 8 | Agent scratch (5 s) | not database data. The poll is replaced by a refetch on that agent's `node_event` (turn end, file presented) and on focus |
| 9 | Gallery (5 s) | shared window `document` (newest page) + subscribed `agent_documents:<id>` for an agent's gallery |
| 10 | Agent inbox (5 s) | subscribed window `agent_mail:<id>`: pending (state set) + delivered (newest 50) + sent (newest 50). The memory overlay part comes via the runtime overlay |
| 11 | Docket (5–15 s) | shared state set `work_item` (active items as the list shows them) + the `org` group `work_summary`. The archive pages stay cold reads |
| 12 | Agent chat (2.5 s / 7 s) | messages live in the SQLite transcript store, not in an org database. The heartbeat is replaced by an incremental fetch (`after=` the last message) on that agent's `node_stream` / `node_event` frames and on focus. No timer |
| 13 | Desktop notifications (5 s, main process) | app socket: per-org `org_notices` frames (§5.2) |

**Windows.** A window record set is the newest K entries of its stream by the stream's order key.
- An entry pushed out of the window is a tombstone in the next frame. An entry that moves up into it, after a member is deleted, is an upsert. The write that caused either one names it (rule M, §3.3).
- An edit to an entry outside the window produces nothing.
- Older pages stay explicit cold reads, as paging is today.

**Removing the polls.** Each panel moves to records in the same commit that removes its timer and its livebus refetch. A renderer test asserts that no timer fetch of org data remains: a static scan for `usePolled`/`setInterval` on org endpoints, with an allowlist that names each remaining non-org timer (UI clocks, engine stats) and why it stays.

## 7. Tests

- **Design §2.5's tests:** the two-session barriers, a killed listener, a prune racing a catch-up, reordered and duplicate frames, an org replaced under the same slug, a baseline inside a batch, delayed answers, overlapping frames, and no later commit. In every case the renderer's store equals a fresh baseline at its final cursor, compared projection by projection.
- **Capture:**
  - for every fed table, a write produces exactly its derivation's change rows, OLD and NEW included;
  - a rollback and a savepoint rollback leave none;
  - a test fails when a table is missing from the map.
- **The flush:**
  - one revision per committing transaction, and none for a no-op;
  - no gaps under 8 concurrent writers;
  - the NOTIFY payload;
  - a job, a compatibility-view save and a native writer each get exactly one revision;
  - a transaction that writes only `changes` rows (the time-boundary job) gets exactly one revision and one NOTIFY.
- **Bulk invalidation (§2.2), each with no later commit:**
  - a client already at the newest R resets after an in-place rewrite;
  - a catch-up in a snapshot from before the rewrite, then the next one, which resets;
  - a prune that chose its floor before a bulk rewrite commits after it, and the floor does not go down;
  - the live sockets receive `record_reset`.
- **Lock order:** `test_orgdb_lock_order.py` covers the capture triggers and the flush, with `changes` and `revisions` under the revision row. Planted faults are caught: the flush writing a row before the revision row, a capture trigger reading another table at statement time, and `resolve_scopes` called from anywhere but the flush.
- **Bodies equal today's payloads:** for each entity, the record body equals the element of today's endpoint payload for the same state, overlay fields aside.
- **Membership:**
  - archiving and unarchiving moves an agent out of and into the shared set;
  - pile representatives change;
  - a held record that is deleted or archived becomes a tombstone.
- **Rule M (§3.3).** For each kind of set, writes that change only ANOTHER record's membership, each with no later write:
  - with K = 1, an insert into the window and then a delete from it;
  - an insert into a full window, and a delete from a full window;
  - a predicate change across a window's edge;
  - an older archived child entering a pile, and a pile edge leaving;
  - a parent move with archived ancestors.

  Also, per kind, a seeded random sequence of such writes. After each commit, two stores must each equal a fresh baseline at the same cursor: the store built from frames, and the store built by an HTTP catch-up from an older cursor.
- **Concurrent writers (§3.3, finding f26).** Two sessions with a barrier: both finish their statements, captures included, before either commits. Each case runs in both commit orders. A client takes a baseline at the cursor between the two commits, and no write follows the second. Frame and HTTP stores must equal a fresh baseline at both cursors.
  - a newest-1 window and two inserts (the f26 example), and a newest-K window with an insert racing a delete;
  - two archives at the same pile edge, and an archive racing an unarchive in one pile;
  - a parent move racing an unarchive below the moved agent;
  - a rename racing a write that references the agent by name;
  - a successor change racing a write that reads the lineage chain.

  A planted fault that resolves the scopes at statement time instead of in the flush must fail these tests.
- **Subscriptions (§1.3):**
  - a subscription at an unchanged R is answered with no commit;
  - a subscription while the client's cursor lags the host's;
  - a live update during the subscription's read;
  - unsubscribe, then subscribe again, before the old answer arrives;
  - an HTTP catch-up that names the subscriptions.

  In each, the store equals a fresh baseline plus the subscriptions' records at the same cursor, and an unsubscribed window never comes back.
- **Names outside the set (§1.2, §3.2):**
  - a live successor whose archived predecessor is outside every set shows the predecessor's name, and renaming the predecessor updates the successor's record;
  - a pinned archived agent outside the shared set receives its settings-derived values when an org setting changes.
- **Runtime overlay (§4.3), each with no later database commit:**
  - a delayed full overlay arrives after a newer live value, and the newer value stays;
  - an org replaced under the same slug;
  - a host restart, which starts a new epoch.
- **Time boundaries:** the ask window, a watchdog tomb and a docket deadline each change the record at the boundary through a revision, with no other write.
- **Scale:** a catch-up's statements and rows read do not grow with history (10× seeded archive), within the A8 guards. A setting that dirties every agent above the bound answers `record_reset`. The time the flush holds the revision row, scope resolution included, is measured on the A8 hot writes and stays within their guards.
- **The app socket (§5):**
  - **registry snapshots (finding f32):** an org created at 11 and deleted at 12, read by the host at 10, 11 and 12, and at 10 and 12 only; a client holding 11 from a socket frame and from an HTTP read; the snapshot at 11 delivered after the one at 12; an org changed and changed back between two host reads. With no later write, every client's registry equals the registry at 12;
  - another app identity comes only with a new epoch, and its first full copy replaces everything;
  - each org's summary converges after its last commit, including when that commit's NOTIFY was lost (the feed's poll finds it), and the registry converges when an `app_rev` NOTIFY is lost;
  - an org's cost, agent count and name change with no write to `orgs`, and its summary follows;
  - the listener is lost and reconnects with no later commit, and the summaries converge;
  - an org update races an app baseline, and the client keeps the newer summary;
  - **replaced databases (finding f33), each with no later org write:** a Retry rebuild of an org whose new incarnation sorts before, and after, the old one as a uuid, with a lower `rev`; an old HTTP full copy delivered after the new live summary; an old notice set delivered after the replacement; a replacement whose six summary values are equal, which still sends a removal and then the new identity; a read in flight when its span ends, which is not stored. The client shows the new database's summary and notices;
  - every (re)connect brings the full summaries, notices and runtime values;
  - `GET /api/orgs/records` stays the tree of an org named "Records".
- **Switch off:** the protocol is unchanged.

## 8. Pieces and order

| Piece | Contents | Needs |
|---|---|---|
| **B4a** | org migration (next free number): `changes`, `revisions`, `floor`; capture triggers + the derivation map for the tree's tables; the flush as the single revision point (on_save_commit and the jobs rule changed), with scope resolution after the revision row (§2.2, §2.3, §3.3) and the static test on deferred triggers; `/records`, `/changes`, live frames, the runtime overlay; `org` groups + `agent` records; rule M for the tree's sets (piles, ancestors) and the generator for declared windows (§3.3); subscriptions with sets and generations (§1.3); the overlay's `(epoch, seq)` rule (§4.3); bulk invalidation (§2.2); the time-boundary job and the prune on host timers (§2.4, §2.5); the revision subscriber list and the frame machinery, shared with the app socket (§5.4); B-1; renderer R1–R2; the capability on; the tree heartbeat and the `changed`/livebus path removed for the tree | nothing beyond v3 |
| **B4b** | the app socket `/api/app/ws`, with `/api/app/records`; the app identity and the registry revision (app migration, next free number); `registry_org` records in whole-registry snapshots (§5.1); per-org `org_summary` and `org_notices` entries with active spans (§5.2); `app_runtime` frames; the org-list poller, the app-wide polls and the main-process notification poll removed | B4a's revision subscriber list, frame machinery and `(epoch, seq)` counter (§5.4) |
| **B4c** | panels 3/4, 5, 6, 9, 11 (shared windows and sets) and 7, 10 (subscribed windows), each window declared for rule M, with their polls removed; 8 and 12 to event-driven refetch | B4a. Each panel's map entries follow B1/B2's reshape of its tables, whichever lands first updating the map |
| **B4d** | the time-boundary job (§2.5) and the retention prune (§2.4) move from host timers onto the jobs framework | B3 |

Every piece lands behind the capability. The renderer keeps the old paths until a panel's records are live.
