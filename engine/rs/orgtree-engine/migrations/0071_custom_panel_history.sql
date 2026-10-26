-- A copy's History holds only fired events agents can listen to and the copy
-- starting and stopping (user 2026-10-26 md6edfebc1975: "put events on its own
-- tab and make it only for fired events agents can listen to and starting /
-- stopping, dont record anything else"). Answers mcbcd7b3cb6c0: the old
-- lifecycle rows are deleted on upgrade, and messages sent with the event
-- action or orgtree.emit keep reaching orgtree.on from a store kept apart from
-- History. Each kind keeps its own latest 256 rows per copy.
ALTER TABLE ot.custom_panel_events ADD COLUMN kind text NOT NULL DEFAULT 'history'
  CHECK (kind IN ('history','message'));
DELETE FROM ot.custom_panel_events
  WHERE name IN ('panel.opened','panel.created','panel.changed','panel.duplicated','state.changed');
UPDATE ot.custom_panel_events SET kind='message'
  WHERE name NOT IN ('event.fired','panel.started','panel.stopped');
CREATE INDEX custom_panel_events_kind_page ON ot.custom_panel_events(org_id,panel_id,kind,seq);
