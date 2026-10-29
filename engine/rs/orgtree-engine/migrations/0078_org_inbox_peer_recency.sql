-- The Connections lists order each hub's connections by the newest mail this
-- org exchanged with each of them, either way (user 2026-10-29 m3e3829f0bf18:
-- "sorted online first then offline below, and also within those groups
-- ordered by most recent correspondence with the org"). net/recent.rs reads
-- it with one backward probe of this index per listed address, so the read
-- never grows with the mail history. Index only; IF NOT EXISTS keeps it
-- idempotent.
CREATE INDEX IF NOT EXISTS org_inbox_peer_at ON ot.org_inbox (org_id, peer, at);
