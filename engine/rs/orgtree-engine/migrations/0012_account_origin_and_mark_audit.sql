-- 3.x parity (F01/F02). Every manual mark clear is recorded here in the same
-- transaction as the delete (3.x registry.clear_mark wrote both in one save).
-- `org` is the clearing org's slug, NULL for the user's own app surface.
CREATE TABLE ot.account_mark_audit (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  actor    text NOT NULL,
  org      text,
  via      text NOT NULL,
  account  text NOT NULL,
  source   text NOT NULL DEFAULT 'registry',
  pool     text NOT NULL,
  cleared  jsonb NOT NULL,
  kept     jsonb NOT NULL DEFAULT '{}',
  reason   text NOT NULL DEFAULT ''
);
CREATE INDEX account_mark_audit_account ON ot.account_mark_audit (account, id DESC);

-- One-time repair: the 2.x/3.0 registry importer kept a legacy org key's
-- restriction only in `extra`. Restore the boundary column from it.
UPDATE ot.accounts SET origin_org = extra->>'origin_org'
 WHERE origin_org IS NULL AND coalesce(extra->>'origin_org', '') <> '';
