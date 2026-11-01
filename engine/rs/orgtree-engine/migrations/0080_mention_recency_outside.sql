-- The @ menu lists outside addresses (@net: contacts and @org: orgs) by recency too (user 2026-11-01
-- m6a66447606a0: "want recency time for outside addresses based on last message sent / received / last
-- time mentioned in chat"). Mentions of them in mail are kept in the same one-row-per-thing table as
-- every other mention; mail sent to or received from an address is already indexed by
-- org_inbox_peer_at (0078). Only the table's kind check widens.
ALTER TABLE ot.mention_recency DROP CONSTRAINT mention_recency_kind_check;
ALTER TABLE ot.mention_recency ADD CONSTRAINT mention_recency_kind_check
  CHECK (kind IN ('node','item','doc','app','panel','net','org'));
