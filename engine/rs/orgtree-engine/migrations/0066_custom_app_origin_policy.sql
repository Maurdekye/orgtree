-- Origin is local engine metadata, never trusted portable app data.
ALTER TABLE ot.custom_apps ADD COLUMN origin text NOT NULL DEFAULT 'legacy'
  CHECK(origin IN ('created','imported','template','legacy'));
ALTER TABLE ot.custom_app_file_grants ADD COLUMN implicit boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX custom_app_implicit_grant ON ot.custom_app_file_grants(org_id,app_id,app_rev,mode) WHERE implicit;
