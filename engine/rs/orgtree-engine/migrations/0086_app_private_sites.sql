-- Private sites for apps (USER 2026-11-11 m27cc41f6b6d1 "A: extend apps"; spec C:/orgtree-build/app-net-opus/
-- spec-remote-viewer-apps.md section 3). A user may allow one exact declared site on the private network; the
-- row in custom_apps.site_permissions is then {"value":"allow-private","addresses":[...]} (pinned when it was
-- allowed). The Permission history gains entries for that, for a re-pin and (piece 3) for a saved login, and a
-- detail column that carries the pinned addresses; neither ever holds a secret.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'ot.custom_app_permission_log'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%once%'
  LOOP
    EXECUTE format('ALTER TABLE ot.custom_app_permission_log DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE ot.custom_app_permission_log
  ADD CONSTRAINT custom_app_permission_log_permission_check
  CHECK (permission IN ('ask','allow','deny','default','once','allow-private','repin','login-saved','login-replaced','login-removed')),
  ADD COLUMN detail text;
