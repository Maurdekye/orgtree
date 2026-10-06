-- The mail hub client: the hub an outside message travelled through (a read
-- receipt goes back to it), and the lookups the client makes by hub id.
ALTER TABLE ot.org_inbox ADD COLUMN hub text;
CREATE INDEX org_inbox_net_in ON ot.org_inbox (org_id, net_id) WHERE dir = 'in' AND net_id IS NOT NULL;
CREATE INDEX org_inbox_net_out ON ot.org_inbox (net_id) WHERE dir = 'out' AND net_id IS NOT NULL;
