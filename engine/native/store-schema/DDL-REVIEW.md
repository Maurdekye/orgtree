# P03 WS2 DDL review against v6 SCHEMA-CATALOG

**Scope:** migrations `0001`-`0008` (WS2 range) as of branch `p03/ws2-storecore`. This is the plan's "DDL review checklist against SCHEMA-CATALOG" (P03-PLAN WS2, Verification). Author: p03-ws2-storecore, 2026-09-25. It is the author's own check; the independent review is separate.

**Evidence the DDL is accepted by PostgreSQL 18.6:** `tests/pg.rs::schema_applies_and_grants_bite` (39 tables; runtime role refused DELETE on receipts, writes to `store_incarnation` and DDL; the claimed-at-commit trigger fires), run under the P03 lock (logs `pg-34c8275.log`, `pg-5742d0d.log`). WS1's migration runner also applied 0001-0008 cleanly (relayed by WS1, not re-measured here).

## Cross-cutting rules (SCHEMA-CATALOG:5, :27-29) — how each is enforced

| Rule | Status | Enforcement |
|---|---|---|
| Immutable ids; `org_id` in every org-scoped key and FK | met | lint R1 (PK starts with `org_id`), R6 (org-scoped FK includes `org_id` first); installation tables listed explicitly (`store_incarnation`, `service_incarnations`, `publication_catalog`) |
| Exact credit values, no float accounting | met | credits are `bigint` hundredths (`*_centi`); lint R3 refuses `numeric`/`money`/`decimal`/`real` and non-bigint `*_centi` |
| Byte-exact identity keys | met | `COLLATE "C"` on every name/key/slug/resource/fingerprint text; lint R2 |
| Named constraints (they are API) | met | lint R4 (prefixed by table), R5 (unique), R7 (no unnamed inline constraints) |
| No `prepared_records`, distributed decisions, replay slots, custody floors, cross-file journal | met | none exist |
| USER pool is an explicit unlimited mode, not a balance row | met | `funding_edges.issuer_id IS NULL` = user root; no user balance row; kiosk cap is `kiosk_pool` (E8), kiosk orgs only |
| Sender never updates or locks the destination mailbox head | met | `mail_sent` has no FK to `mailboxes` (lead F3); lint R10 forbids source-side FKs to receiver heads |
| No FK from a high-rate table to an org-wide row | met | lead F2; lint R9 over `HIGH_RATE_TABLES` |
| Narrow version rows never share busy/status fields | met | `authority_epoch` (lifecycle, generation, halt, versions) is separate from `runtime_state` (busy, status, notes) |
| Table growth classified; bounded bodies | partial | JSON/body columns carry byte CHECKs; the per-table class (current / temporary / retained / fixed corpus) is stated in comments only for receipts, versions and legacy names. **Gap:** a machine-readable class per table is not recorded — WS8's churn-then-settle report needs it. |

## Per catalog row

| SCHEMA-CATALOG row | Tables in the slice | Status and gaps |
|---|---|---|
| `organizations`, controls, catalog | `organizations`, `org_controls` (one row per control family), `catalog_current`, `price_catalog` | met. Control **history** is not in the slice (not needed by P03 schedules). |
| `agent_identity`, `agent_membership`, `topology_edges` | `agents`, `agent_names` (active names + reservations, one namespace), `authority_epoch`, `topology_edges`, `scope_rows` | met for the slice. Deviation: identity and membership are one `agents` table plus the narrow `authority_epoch`; the membership version is `authority_epoch.version`. **Gap for WS3:** lineage stacks / bearers are not modelled; WS3 adds them in its range. |
| `agent_config`, `configuration_intents`, charter heads/versions | `charter_heads`, `charter_versions` | charters met. `agent_config` / `configuration_intents` are **absent**: queued config is excluded from P03 (coordinator ruling Q7). |
| `issuer_capacity`, `funding_edges`, price catalog | `issuer_capacity` (unpriced aggregates, RN4), `funding_edges` (one per child), `kiosk_pool` | met. Conservation and non-negativity beyond the column CHECKs are enforced by commands (WS4), as the catalog says. |
| `runtime_state`, `runtime_claims`, `input_batches`, `input_evidence` | `runtime_state`, `runtime_claims` (one active per seat), `runtime_inflight`, `service_incarnations` | minimal runtime met. `input_batches`/`input_evidence` are **absent**; WS5 adds `mail_input_batches` (0300, relayed from WS5). |
| `mailboxes`, `mailbox_messages`, `mailbox_receipts` | `mailboxes` (P8 head), `mailbox_messages` (unique `(mailbox, original message id)`), `mail_pair_highwater`, `mail_sent` | met for dedupe and order. Deviation: receipt outcomes are states of `mailbox_messages` rather than a separate `mailbox_receipts` table; WS5 owns the final form (its 0300 extends the states). |
| `outgoing_intents`, `transport_intents`, `effect_receipts` | `outgoing_intents`, `transport_intents` (unique causal effect keys, due indexes) | **Gap:** `effect_receipts` is absent; external effects in the slice use the fake transport (WS5 decides whether it needs the table). |
| `request_batches`, tabs, submissions | `request_batches` (one pending per asker and kind) | **Gap:** tabs and submissions are absent; WS4 adds them if its credit/ask schedules need a winning-submission key. |
| `work_items` and row families | `work_items` (head with rev), `work_item_versions`, `work_participants` | met for the slice (item revision CAS, participants on the head). Checks, reviews, findings, links and attention rows are outside the slice. |
| `active_work_names`, `legacy_work_names` | both | met: exact bytes, 76-byte bound on new names, fixed legacy corpus read-only to the runtime role. |
| Authority / grants / consumers | `audience_grants` (+ epoch bump rule), `read_service_registrations`, `restrictions`, `restriction_obligations` | met; the registration/capture ordering follows lead ruling F1 and is exercised by Q-C6 on the database. |
| Other resources | `resource_reservations` with K1-K4 | met for reservations. Watchdogs/timers are outside the slice. |
| Transcript sources/records/projection | none | **absent**: `material.transcript` in P03 reads the fixture's files through the strict-read slot (WS4); no transcript tables are needed for the gate. |
| `operation_receipts`, retained events | `operation_receipts` (unique original key per namespace, `db_incarnation`, claimed-at-commit trigger; published with safe columns only) | met. Retention is P06; retained resource events are **absent** (the receipt row is the feed's group link, CONTRACT-M1 §3.7). |
| Versioned publication catalog | `publication_catalog` | table met; rows and the publication itself are WS6's. |
| Read model / projection control | none | WS6's range. |
| Migration / compatibility | none | out of P03 (P04). |

## Findings to carry

1. **Growth class per table** is not machine-readable (see the cross-cutting table). Proposed: a `TABLE_CLASS` list in `store-schema` beside `PUBLISHED`/`EXCLUDED`, with a test that every table has one. Small; can land with WS8's needs.
2. Absent catalog tables are listed above with their owner. None is required by a WS2 schedule.
3. WS5's 0300 replaces `mail_sent_pair_shape` and `mailbox_messages_state` (relayed from WS5): the base check on those columns is intentionally superseded in WS5's range.
