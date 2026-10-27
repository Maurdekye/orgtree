-- A fired event's body as it was sent (user 2026-10-27 mc308cabf3c5f, "Save
-- exactly" and "Agents see bodies", after mda08162683ef "this should show the
-- event's body as it was transmitted"; replaces the 2026-10-26 metadata-only
-- History): the compact JSON text the engine received, key order kept, stored
-- with the copy's History row and kept as long as that row. Other rows have none.
ALTER TABLE ot.custom_panel_events ADD COLUMN body text CHECK (body IS NULL OR octet_length(body) <= 131072);

-- A History row finds its fire by the fire's id, and a fire its row.
CREATE INDEX custom_panel_events_fire ON ot.custom_panel_events (org_id, (payload->>'id'))
  WHERE kind = 'history' AND name = 'event.fired';

-- Fires recorded before this kept only metadata in History. The delivery outbox
-- still holds the newest finished fires' bodies, as jsonb stored them (keys
-- reordered, spacing normalized); rows it no longer holds keep none ("not kept").
UPDATE ot.custom_panel_events e SET body = f.payload::text
  FROM ot.app_event_fires f
 WHERE e.kind = 'history' AND e.name = 'event.fired' AND e.body IS NULL
   AND f.org_id = e.org_id AND f.uid = e.payload->>'id';
