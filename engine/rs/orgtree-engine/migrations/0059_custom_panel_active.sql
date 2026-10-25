ALTER TABLE ot.custom_panels ADD COLUMN event_seq bigint NOT NULL DEFAULT 0;
UPDATE ot.custom_panels p SET event_seq=(SELECT coalesce(max(e.seq),0) FROM ot.custom_panel_events e WHERE e.org_id=p.org_id AND e.panel_id=p.id);
CREATE INDEX custom_panels_open_page ON ot.custom_panels(org_id,id) WHERE is_open;
