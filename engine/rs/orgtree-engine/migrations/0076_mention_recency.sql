-- The @ menu lists every kind newest first by the latest of when each thing
-- was mentioned, operated on or presented (user 2026-10-27 m79e889ce1609: "and
-- ofc sort all items by most recently mentioned / operated on / presented").
-- Operating and presenting are already on each row; this keeps the mentions:
-- the newest time each agent or project name, ticket, presentation, app and
-- panel was mentioned in mail, by anyone, in its org. One row per thing named,
-- so it never grows with the mail history.
CREATE TABLE ot.mention_recency (
  org_id bigint NOT NULL REFERENCES ot.orgs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('node','item','doc','app','panel')),
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 200),
  at timestamptz NOT NULL,
  PRIMARY KEY (org_id, kind, key)
);

-- Mail is read for mentions after it is written, in bounded batches, by the
-- @ menu's own read (domain/mention_candidates.rs): one cursor for every org,
-- so no mail write path changes. It starts this many messages back, so the
-- first reads learn recent mentions without one read over all history.
CREATE TABLE ot.mention_recency_state (
  id integer PRIMARY KEY CHECK (id = 1),
  mail_id bigint NOT NULL
);
INSERT INTO ot.mention_recency_state (id, mail_id)
  SELECT 1, greatest(0, coalesce(max(id), 0) - 20000) FROM ot.mail;
