-- Keep full inputs off the normal transcript projection. Row identity also
-- disambiguates providers that reuse tool ids across turns or sessions.
ALTER TABLE ot.convo ADD COLUMN tool_inputs jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ot.convo ADD COLUMN tool_native_inputs jsonb NOT NULL DEFAULT '{}'::jsonb;
