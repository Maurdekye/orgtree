-- Human viewer read state is independent of agent extraction/publication.
ALTER TABLE ot.org_inbox ADD COLUMN dnd_held boolean NOT NULL DEFAULT false;
ALTER TABLE ot.org_inbox ADD COLUMN pulled_by bigint REFERENCES ot.agents(id);
ALTER TABLE ot.org_inbox ADD CONSTRAINT org_inbox_dnd_incoming CHECK (NOT dnd_held OR dir='in');
CREATE INDEX org_inbox_dnd_held ON ot.org_inbox(org_id, id) WHERE dnd_held;
