-- 4.7.0: blocking contacts on the mail hub (Mail hub 2.6.0 feature
-- `blocking`; user 2026-11-24 18:56Z m020bbd1926c3, 19:06Z m61f5367a61e7).
-- What this org wants blocked, who set it and why. The hubs keep and
-- enforce the blocks; the engine makes each hub's list match these rows.
-- set_by is '@user' or the agent's name: an agent can't lift a block the
-- user set (Q1b). reason is the agent's, never sent to a hub.
CREATE TABLE ot.net_blocks (
  org_id   bigint NOT NULL REFERENCES ot.orgs (id),
  address  text NOT NULL,
  set_by   text NOT NULL,
  reason   text,
  at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, address),
  CHECK (length(address) BETWEEN 1 AND 128),
  CHECK (reason IS NULL OR length(reason) <= 500)
);
