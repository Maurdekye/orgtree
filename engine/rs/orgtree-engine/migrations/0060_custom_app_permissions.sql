ALTER TABLE ot.custom_apps ADD COLUMN IF NOT EXISTS permission_rev bigint NOT NULL DEFAULT 1;
