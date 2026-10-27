-- Internet access for apps (user 2026-10-26 m95c57abc95fb: "build internet
-- access as a permission for the apps"; design accepted m232e1d1ccb57).
-- declared_sites is portable definition data like declared_events and grants
-- nothing. site_permissions holds the user's local per-site choices (ask,
-- allow, deny), never exported. custom_app_permission_log is the app-level
-- Permission history: every stored permission change, native prompt answer and
-- code-change reset, latest 128 per app.
ALTER TABLE ot.custom_apps
  ADD COLUMN declared_sites jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(declared_sites)='array'),
  ADD COLUMN site_permissions jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(site_permissions)='object');
CREATE TABLE ot.custom_app_permission_log (
  org_id bigint NOT NULL,
  app_id text NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  capability text NOT NULL,
  site text,
  permission text NOT NULL CHECK (permission IN ('ask','allow','deny','default','once')),
  via text NOT NULL CHECK (via IN ('change','prompt','code')),
  actor text NOT NULL,
  panel_id text,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id,app_id,seq),
  FOREIGN KEY(org_id,app_id) REFERENCES ot.custom_apps(org_id,id) ON DELETE CASCADE
);
