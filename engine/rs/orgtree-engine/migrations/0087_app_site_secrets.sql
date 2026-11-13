-- Saved logins for apps (USER 2026-11-11 m27cc41f6b6d1; spec section 4). One sealed login per app and exact
-- site. `sealed` is AES-256-GCM under the data root's watchdog-credentials key with an AAD naming
-- org, app and site (domain/apps/logins.rs); it holds the kind, any header name and the value, never in the
-- clear. `kind` repeats the kind for the desktop's "Saved login: Bearer token" line, which shows no value.
-- The row goes with its app (ON DELETE CASCADE) and is never exported.
CREATE TABLE ot.app_site_secrets (
  org_id bigint NOT NULL,
  app_id text NOT NULL,
  site text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bearer','header')),
  sealed bytea NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, app_id, site),
  FOREIGN KEY (org_id, app_id) REFERENCES ot.custom_apps(org_id, id) ON DELETE CASCADE
);
