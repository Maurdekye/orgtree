-- USER 2026-10-26: a visible panel is always running; a running panel need not
-- be visible. Execution intent survives restarts; the generation fences hosts.
ALTER TABLE ot.custom_panels ADD COLUMN is_running boolean NOT NULL DEFAULT false;
ALTER TABLE ot.custom_panels ADD COLUMN run_generation bigint NOT NULL DEFAULT 1 CHECK (run_generation>0);
UPDATE ot.custom_panels SET is_running=is_open;
ALTER TABLE ot.custom_panels ADD CONSTRAINT custom_panel_visible_running CHECK (NOT is_open OR is_running);
CREATE INDEX custom_panel_running ON ot.custom_panels(org_id,id) WHERE is_running;
