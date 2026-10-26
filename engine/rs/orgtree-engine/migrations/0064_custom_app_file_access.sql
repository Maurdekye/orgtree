-- Native grants stay out of portable app data. Paths are private host data.
CREATE TABLE ot.custom_app_file_grants (
  org_id bigint NOT NULL,
  app_id text NOT NULL,
  id text NOT NULL,
  app_rev bigint NOT NULL CHECK (app_rev > 0),
  scope text NOT NULL CHECK (scope IN ('orgtree','file')),
  path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id,app_id,id),
  FOREIGN KEY(org_id,app_id) REFERENCES ot.custom_apps(org_id,id) ON DELETE CASCADE,
  CHECK ((scope='orgtree' AND path IS NULL) OR (scope='file' AND path IS NOT NULL))
);
CREATE INDEX custom_app_file_grants_current ON ot.custom_app_file_grants(org_id,app_id,app_rev,id);
ALTER TABLE ot.custom_panels ADD CONSTRAINT custom_panels_app_identity UNIQUE(org_id,app_id,id);
CREATE TABLE ot.custom_app_file_refs (
  org_id bigint NOT NULL,
  app_id text NOT NULL,
  panel_id text NOT NULL,
  id text NOT NULL,
  app_rev bigint NOT NULL CHECK (app_rev > 0),
  grant_id text NOT NULL,
  path text NOT NULL,
  PRIMARY KEY(org_id,app_id,panel_id,id),
  FOREIGN KEY(org_id,app_id,panel_id) REFERENCES ot.custom_panels(org_id,app_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,app_id,grant_id) REFERENCES ot.custom_app_file_grants(org_id,app_id,id) ON DELETE CASCADE
);
CREATE INDEX custom_app_file_refs_page ON ot.custom_app_file_refs(org_id,app_id,panel_id,app_rev,id);
