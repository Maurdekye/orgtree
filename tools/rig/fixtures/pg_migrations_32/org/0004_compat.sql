-- The compatibility view's bookkeeping (design §6.2 item 3, orgdb/compat), and the org's
-- operation receipts.
--
-- compat_meta: the legacy meta rows no domain table holds, dropped with the view (design
-- §6.3 step 8):
--   key_order   the document's recorded top-level key order, exactly as the engine last
--               wrote it (one value, like the legacy meta row; until the first write the
--               converted order in org_sections is served)
--   heal_epoch  the load-heal stamp (store.stamp_heal_epoch)
--   schema_version  written by the first save of an org created with the switch on
CREATE TABLE orgtree.compat_meta (
  key  text PRIMARY KEY,
  val  text NOT NULL
);

-- org_tx operation receipts: today's public.receipts rows of this org (design §2.1,
-- "Idempotency"), written in the same transaction as the change, so a retry after a lost
-- commit finds its outcome.
CREATE TABLE orgtree.tx_receipts (
  op_key       text PRIMARY KEY,
  fingerprint  text,
  result       text,
  at           timestamptz NOT NULL DEFAULT now()
);
