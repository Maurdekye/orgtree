-- Inert portable names only; delivery and permissions are separate.
ALTER TABLE ot.custom_apps ADD COLUMN declared_events jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(declared_events)='array' AND jsonb_array_length(declared_events)<=64);
