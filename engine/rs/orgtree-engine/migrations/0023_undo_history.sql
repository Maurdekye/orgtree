-- The user's persistent undo history (docs/rust-engine/undo-history.md).
-- One head row per org is the history lock and the feed revision; entries
-- hold only typed, allowlisted facts (numeric agent ids, positions, field
-- values), never request bodies, settings objects, credentials or text.
CREATE TABLE ot.undo_heads (
  org_id bigint PRIMARY KEY REFERENCES ot.orgs (id),
  rev    bigint NOT NULL DEFAULT 0
);
CREATE TABLE ot.undo_entries (
  id         bigserial PRIMARY KEY,
  org_id     bigint NOT NULL REFERENCES ot.orgs (id),
  kind       text NOT NULL CHECK (kind IN ('move', 'hire', 'retire', 'retool')),
  state      text NOT NULL DEFAULT 'done' CHECK (state IN ('done', 'undone', 'refused')),
  label      text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  request_id text CHECK (request_id IS NULL OR char_length(request_id) BETWEEN 1 AND 64),
  data       jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  reason     text CHECK (reason IS NULL OR char_length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT undo_entries_reason CHECK ((state = 'refused') = (reason IS NOT NULL))
);
CREATE UNIQUE INDEX undo_entries_request ON ot.undo_entries (org_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX undo_entries_org ON ot.undo_entries (org_id, state, id);
