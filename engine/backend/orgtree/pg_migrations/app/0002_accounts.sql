-- The machine-wide billing accounts (design §2.10, §3.1): today's accounts-registry.json
-- (registry.py), minus the accounts restricted to one org, which live in that org's own
-- database (org_accounts, rev 4 f7). One account serves agents in every org: a limit mark set
-- by a turn in org A stops turns in org B, and spend is metered machine-wide, so several
-- processes update marks and spend here in transactions.
--
-- Hand-written. The rows are written by orgdb/convert/accounts.py through the exact codec:
-- an unknown field, or a value of another shape than its column's, is kept in the row's extra
-- JSON (§3.0), and tests/test_orgdb_accounts.py checks every column here against its specs.
-- The registry's numbers are epoch seconds and stay double precision, exactly as stored.

-- One row per machine-wide account, in the file's order (ord).
--   id                  the stable account id ('claude-3'): allocated once, never reused
--   marks_is, spend_is  the account's marks and spend: NULL absent, 'n' null, 'o' held by
--                       account_marks / account_spend, 'x' kept whole in extra
--   removing            a removal in progress (registry.set_removing; kept in memory today)
--   credential_*        {kind, path | token_ref, default_config}: a profile folder or a
--                       token-store reference, never key material (design §2.10's
--                       credential_kind and credential_ref, the ref kept under its own key)
--   identity            the provider's account description: shapeless (Q1)
CREATE TABLE orgtree.accounts (
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
  "extra" json
);

-- one limit mark per (account, pool): the account's capacity for that pool is used up until
-- `until`; provenance observed or inferred (registry.record_mark)
CREATE TABLE orgtree.account_marks (
  account_id text NOT NULL REFERENCES orgtree.accounts (id) ON DELETE CASCADE,
  pool text NOT NULL,
  "until" double precision,
  "window" text,
  "observed_at" double precision,
  "provenance" text,
  "extra" json,
  PRIMARY KEY (account_id, pool)
);

-- an API-key account's local metering, machine-wide (registry.add_spend)
CREATE TABLE orgtree.account_spend (
  account_id text PRIMARY KEY REFERENCES orgtree.accounts (id) ON DELETE CASCADE,
  "usd_total" double precision,
  "turns" bigint,
  "since" double precision,
  "updated_at" double precision,
  "extra" json
);

-- {alias: account id} ('primary' -> the Claude machine login's row), in the file's order (ord).
-- No foreign key: the registry keeps an alias exactly as written. An alias naming an account
-- restricted to one org lives in that org's database instead (org_account_aliases)
CREATE TABLE orgtree.account_aliases (
  alias text PRIMARY KEY,
  ord integer NOT NULL UNIQUE,
  "account_id" text,
  "extra" json
);

-- per provider, the last account id number and tint ordinal allocated (registry's
-- id_counters and tint_counters; NULL when a provider is absent from one of them). The ids of
-- the org-restricted accounts are minted from these too, so no id is ever reused on this
-- machine (§2.10)
CREATE TABLE orgtree.account_counters (
  provider text PRIMARY KEY,
  "id_counter" bigint,
  "tint_counter" bigint,
  "extra" json
);

-- the manual mark clears, oldest first (registry.clear_mark keeps the last 200); cleared and
-- kept are the marks as they were, whole. A clear of an account restricted to one org lives in
-- that org's database instead (org_account_mark_audit)
CREATE TABLE orgtree.account_mark_audit (
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

-- the registry document's top-level keys, in order: 'v' held by its table or app_settings
-- column, 'n' null, 'x' kept whole in val (a key this schema does not know, or a container of
-- another shape). Empty until the registry is converted
CREATE TABLE orgtree.account_registry_keys (
  "key" text PRIMARY KEY,
  ord integer NOT NULL UNIQUE,
  state char(1) NOT NULL CHECK (state IN ('v', 'n', 'x')),
  val json,
  CONSTRAINT account_registry_keys_val CHECK ((state = 'x') = (val IS NOT NULL))
);

-- the registry's other machine-level stamps, beside accounts_version and apikey_cutover_at
-- (0001): migrated_at, the accounts migration's completion marker
-- (registry_migration.mark_migrated). Both stamps are epoch seconds in the file: the
-- timestamptz is that instant to the microsecond, and the _text column keeps the stored
-- number's exact JSON text (§3.0)
ALTER TABLE orgtree.app_settings
  ADD COLUMN accounts_migrated_at timestamptz,
  ADD COLUMN accounts_migrated_at_text text;
