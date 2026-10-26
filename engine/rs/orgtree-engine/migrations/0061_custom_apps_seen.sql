-- A definition is new until its catalog entry is seen. This is org-owned UI
-- metadata, independent of app code/state/grants and excluded from portability.
-- Provisional self-import rule: user imports are new too, until seen in Apps.
ALTER TABLE ot.custom_apps ADD COLUMN is_new boolean NOT NULL DEFAULT true;
CREATE INDEX custom_apps_new ON ot.custom_apps(org_id,id) WHERE is_new;
