-- The org-owned rows of today's machine-level side files, and the accounts restricted to this
-- org (design §2.10, §3.2–3.8 "Additions", §5.2 step 4 and "Accounts").
--
-- Hand-written. The rows are written by orgdb/convert/sidefiles.py (reply_events,
-- file_deliveries) and orgdb/convert/accounts.py (org_accounts and its two child tables)
-- through the exact codec: a value no column holds exactly is kept in the row's extra JSON
-- (§3.0). tests/test_orgdb_sidefiles.py and tests/test_orgdb_accounts.py check every column
-- here against those specs. Column names are quoted where legacy keys are reserved words.

-- Today's reply-events.sqlite3 rows for this org: one immutable quoted snapshot per (agent,
-- generation, id), which a quoted reply resolves. public_id is the event's own id
-- ('reply_<sha256>'), text the quote, scope the incarnation pair it was minted under. A quote
-- holding U+0000 (7 rows on the live copy) is kept in extra. An agent name no node carries
-- points at a tombstone row (§3.0).
CREATE TABLE orgtree.reply_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id bigint NOT NULL REFERENCES orgtree.agents (id) ON DELETE CASCADE,
  "generation" bigint,
  "public_id" text,
  "text" text,
  "scope" text,
  "extra" json
);

-- the lookup of reply_events.lookup and the old file's primary key, within this org
CREATE UNIQUE INDEX reply_events_key ON orgtree.reply_events (agent_id, "generation", "public_id");

-- Today's file-deliveries.db receipts that evidence gives this org (§5.2, rev 7.1):
--   id           sha256(slug:lineage_born:delivery_id), as filedelivery.snapshot computes it
--   agent_id     the agent the evidence names, when it names one
--   evidence     'snapshot' (its outbox/delivery-<id>/ folder, in this org's scratch only,
--                with the file matching the saved result) or 'key' (a delivery key from this
--                org's transcripts that recomputes the id); NULL for a receipt the engine
--                writes itself
--   fingerprint  the source path and caption, exactly as stored
--   result       the saved reply, exactly as stored; NULL while the copy never finished
-- A receipt with no such evidence stays in the old file, untouched (decision 18, option X).
CREATE TABLE orgtree.file_deliveries (
  id text PRIMARY KEY,
  agent_id bigint REFERENCES orgtree.agents (id) ON DELETE SET NULL,
  evidence text CHECK (evidence IN ('snapshot', 'key')),
  "fingerprint" text,
  "result" text,
  "extra" json
);

CREATE INDEX file_deliveries_agent ON orgtree.file_deliveries (agent_id);

-- The accounts restricted to this org (origin_org: bindable only here, registry.py), with
-- the same columns as the app database's accounts tables (0002_accounts.sql there) plus
-- origin_org. Binding resolution reads these first, then the machine-wide accounts (§2.10).
-- ord is the row's position among this org's accounts in accounts-registry.json.
CREATE TABLE orgtree.org_accounts (
  id text PRIMARY KEY CHECK (id <> ''),
  ord integer NOT NULL UNIQUE,
  marks_is char(1) CHECK (marks_is IN ('n', 'o', 'x')),
  spend_is char(1) CHECK (spend_is IN ('n', 'o', 'x')),
  removing boolean NOT NULL DEFAULT false,
  row_version bigint NOT NULL DEFAULT 0,
  "provider" text,
  "harness" text,
  "label" text,
  "credential_is" char(1),
  "credential_kind" text,
  "credential_path" text,
  "credential_token_ref" text,
  "credential_default_config" boolean,
  "identity" json,
  "auth" text,
  "mode" text,
  "enabled" boolean,
  "tint_ordinal" bigint,
  "created_at" double precision,
  "registered_from" text,
  "origin_org" text,
  "extra" json
);

-- one limit mark per (account, pool): the account's capacity for that pool is used up until
-- `until` (epoch seconds); provenance observed or inferred (registry.record_mark)
CREATE TABLE orgtree.org_account_marks (
  account_id text NOT NULL REFERENCES orgtree.org_accounts (id) ON DELETE CASCADE,
  pool text NOT NULL,
  "until" double precision,
  "window" text,
  "observed_at" double precision,
  "provenance" text,
  "extra" json,
  PRIMARY KEY (account_id, pool)
);

-- an API-key account's local metering (registry.add_spend)
CREATE TABLE orgtree.org_account_spend (
  account_id text PRIMARY KEY REFERENCES orgtree.org_accounts (id) ON DELETE CASCADE,
  "usd_total" double precision,
  "turns" bigint,
  "since" double precision,
  "updated_at" double precision,
  "extra" json
);

-- the aliases naming one of this org's restricted accounts ({alias: account id}, in the
-- registry file's order), and the manual mark clears of those accounts (registry.clear_mark:
-- the clearing org, actor and reason), oldest first. The app database keeps no trace of them
-- (review f19); both mirror the app database's account_aliases and account_mark_audit
CREATE TABLE orgtree.org_account_aliases (
  alias text PRIMARY KEY,
  ord integer NOT NULL UNIQUE,
  "account_id" text,
  "extra" json
);

CREATE TABLE orgtree.org_account_mark_audit (
  ord integer PRIMARY KEY,
  "at" double precision,
  "actor" text,
  "org" text,
  "via" text,
  "account" text,
  "source" text,
  "pool" text,
  "cleared" json,
  "kept" json,
  "reason" text,
  "extra" json
);
