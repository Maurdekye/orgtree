-- Apps and panels are identified by readable slugs (user 2026-10-27
-- mc70ab563f21d: "apps and panels should have slug based identifiers as well"),
-- made like presentation slugs (0073): the name's ASCII letters and digits
-- (ot.slug_base at 48), -2, -3... on a clash, under a per-org lock, never
-- changed once made. An app or panel may ask for its slug at creation, in
-- English when its name isn't (mea228250b31e); the request is cleaned the same
-- way and one with nothing left after the cleanup is refused.
--
-- THE SLUG IS THE ID. An app's and a panel's id is the key of its panels,
-- History, event fires, file grants and links, permission history and
-- app_listener watchdogs, of the engine's gates and hosts and of the
-- renderer. Rewriting the id once here gives every one of them the readable
-- slug. The old generic id stays on the row as legacy_id, and every way in
-- (the Apps tool and route, app_listener watchdogs, mention reads) accepts it
-- through ot.custom_app_ref / ot.custom_panel_ref, so older mail, mentions,
-- notes and fire mails keep resolving.
--
-- A panel's slug comes from its shown name, "<app> <label>" (Caption board's
-- Panel 1 is caption-board-panel-1), so the default "Panel N" labels stay
-- distinct: panel slugs are unique in the whole org (coordinator 2026-10-27
-- m73a8dfbe169f), because @panel: mentions, watchdogs and tools name a panel
-- without its app.
ALTER TABLE ot.custom_apps ADD COLUMN legacy_id text;
ALTER TABLE ot.custom_panels ADD COLUMN legacy_id text;
CREATE UNIQUE INDEX custom_apps_legacy_id ON ot.custom_apps (org_id, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX custom_panels_legacy_id ON ot.custom_panels (org_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- A name's slug base: ot.slug_base (0073) at 48, or the fallback for a name
-- with no ASCII letter or digit.
CREATE FUNCTION ot.named_slug_base(p_name text, p_fallback text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN (coalesce(p_name, '') COLLATE "C") ~ '[A-Za-z0-9]' THEN ot.slug_base(p_name, 48) ELSE p_fallback END
$$;

-- The first free slug for a base in an org: the base, then -2, -3, ... on a
-- base cut to 44 characters. An old id in the org counts as taken, so a new
-- slug never captures an old reference. VOLATILE on purpose: each check reads
-- what committed before it ran.
CREATE FUNCTION ot.custom_app_slug(p_org bigint, p_base text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  candidate text := p_base;
  n integer := 2;
BEGIN
  WHILE EXISTS (SELECT 1 FROM ot.custom_apps a
          WHERE a.org_id = p_org AND (a.id = candidate OR a.legacy_id = candidate)) LOOP
    candidate := rtrim(left(p_base, 44), '-') || '-' || n;
    n := n + 1;
  END LOOP;
  RETURN candidate;
END $$;
CREATE FUNCTION ot.custom_panel_slug(p_org bigint, p_base text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  candidate text := p_base;
  n integer := 2;
BEGIN
  WHILE EXISTS (SELECT 1 FROM ot.custom_panels p
          WHERE p.org_id = p_org AND (p.id = candidate OR p.legacy_id = candidate)) LOOP
    candidate := rtrim(left(p_base, 44), '-') || '-' || n;
    n := n + 1;
  END LOOP;
  RETURN candidate;
END $$;

-- A panel's base: its app's slug (cut to 32 so the label survives) and its label.
CREATE FUNCTION ot.panel_slug_base(p_app text, p_label text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT ot.named_slug_base(rtrim(left(p_app, 32), '-') || ' ' || coalesce(p_label, ''), 'panel')
$$;

-- Every insert path (app_create, app_import, org templates, panel_open,
-- panel_duplicate) gets its id here, one org at a time. An id given on insert
-- is a requested slug: cleaned and suffixed like a name, refused when the
-- cleanup leaves nothing (the Apps tool refuses it first, in its own words).
CREATE FUNCTION ot.assign_custom_app_slug() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ot.custom_apps.slug/' || NEW.org_id, 0));
  IF NEW.id IS NULL THEN
    NEW.id := ot.custom_app_slug(NEW.org_id, ot.named_slug_base(NEW.name, 'app'));
  ELSIF (NEW.id COLLATE "C") !~ '[A-Za-z0-9]' THEN
    RAISE EXCEPTION 'a requested app slug needs an ASCII letter or digit: %', NEW.id
      USING ERRCODE = 'invalid_parameter_value';
  ELSE
    NEW.id := ot.custom_app_slug(NEW.org_id, ot.slug_base(NEW.id, 48));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER custom_apps_slug BEFORE INSERT ON ot.custom_apps
  FOR EACH ROW EXECUTE FUNCTION ot.assign_custom_app_slug();
CREATE FUNCTION ot.assign_custom_panel_slug() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ot.custom_panels.slug/' || NEW.org_id, 0));
  IF NEW.id IS NULL THEN
    NEW.id := ot.custom_panel_slug(NEW.org_id, ot.panel_slug_base(NEW.app_id, NEW.label));
  ELSIF (NEW.id COLLATE "C") !~ '[A-Za-z0-9]' THEN
    RAISE EXCEPTION 'a requested panel slug needs an ASCII letter or digit: %', NEW.id
      USING ERRCODE = 'invalid_parameter_value';
  ELSE
    NEW.id := ot.custom_panel_slug(NEW.org_id, ot.slug_base(NEW.id, 48));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER custom_panels_slug BEFORE INSERT ON ot.custom_panels
  FOR EACH ROW EXECUTE FUNCTION ot.assign_custom_panel_slug();

-- An app or panel reference: its id (slug), else its old id, in that org only.
CREATE FUNCTION ot.custom_app_ref(p_org bigint, p_ref text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT id FROM ot.custom_apps WHERE org_id = p_org AND (id = p_ref OR legacy_id = p_ref)
   ORDER BY id = p_ref DESC LIMIT 1
$$;
CREATE FUNCTION ot.custom_panel_ref(p_org bigint, p_ref text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT id FROM ot.custom_panels WHERE org_id = p_org AND (id = p_ref OR legacy_id = p_ref)
   ORDER BY id = p_ref DESC LIMIT 1
$$;

-- THE REWRITE. Every foreign key that points at an app, a panel or a file
-- grant (whose key holds the app id) is set aside, found in the catalog so
-- none is missed, and put back exactly as it was once every id has moved.
CREATE TEMP TABLE app_panel_slug_keys ON COMMIT DROP AS
  SELECT c.conrelid::regclass AS rel, c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
   WHERE c.contype = 'f'
     AND c.confrelid IN ('ot.custom_apps'::regclass, 'ot.custom_panels'::regclass, 'ot.custom_app_file_grants'::regclass);
DO $$
DECLARE k record;
BEGIN
  FOR k IN SELECT rel, conname FROM app_panel_slug_keys LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', k.rel, k.conname);
  END LOOP;
END $$;

-- Apps, oldest first in each org, so the first of several with one name keeps
-- the plain slug; then everything that names an app by its old id.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT org_id, id, name FROM ot.custom_apps ORDER BY org_id, created_at, id LOOP
    UPDATE ot.custom_apps SET legacy_id = r.id,
           id = ot.custom_app_slug(r.org_id, ot.named_slug_base(r.name, 'app'))
     WHERE org_id = r.org_id AND id = r.id;
  END LOOP;
END $$;
UPDATE ot.custom_panels p SET app_id = a.id FROM ot.custom_apps a WHERE a.org_id = p.org_id AND a.legacy_id = p.app_id;
UPDATE ot.app_event_fires f SET app_id = a.id FROM ot.custom_apps a WHERE a.org_id = f.org_id AND a.legacy_id = f.app_id;
UPDATE ot.custom_app_file_grants g SET app_id = a.id FROM ot.custom_apps a WHERE a.org_id = g.org_id AND a.legacy_id = g.app_id;
UPDATE ot.custom_app_file_refs l SET app_id = a.id FROM ot.custom_apps a WHERE a.org_id = l.org_id AND a.legacy_id = l.app_id;
UPDATE ot.custom_app_permission_log h SET app_id = a.id FROM ot.custom_apps a WHERE a.org_id = h.org_id AND a.legacy_id = h.app_id;
UPDATE ot.watchdogs w SET target = a.id FROM ot.custom_apps a
 WHERE w.kind = 'app_listener' AND a.org_id = w.org_id AND a.legacy_id = w.target;

-- Panels the same way, after their apps, so each takes its app's new slug.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT org_id, id, app_id, label FROM ot.custom_panels ORDER BY org_id, created_at, id LOOP
    UPDATE ot.custom_panels SET legacy_id = r.id,
           id = ot.custom_panel_slug(r.org_id, ot.panel_slug_base(r.app_id, r.label))
     WHERE org_id = r.org_id AND id = r.id;
  END LOOP;
END $$;
UPDATE ot.custom_panel_events e SET panel_id = p.id FROM ot.custom_panels p WHERE p.org_id = e.org_id AND p.legacy_id = e.panel_id;
UPDATE ot.app_event_fires f SET panel_id = p.id FROM ot.custom_panels p WHERE p.org_id = f.org_id AND p.legacy_id = f.panel_id;
UPDATE ot.custom_app_file_refs l SET panel_id = p.id FROM ot.custom_panels p WHERE p.org_id = l.org_id AND p.legacy_id = l.panel_id;
UPDATE ot.custom_app_permission_log h SET panel_id = p.id FROM ot.custom_panels p WHERE p.org_id = h.org_id AND p.legacy_id = h.panel_id;
UPDATE ot.watchdogs w SET memo = jsonb_set(w.memo, '{panel}', to_jsonb(p.id)) FROM ot.custom_panels p
 WHERE w.kind = 'app_listener' AND p.org_id = w.org_id AND p.legacy_id = w.memo->>'panel';

DO $$
DECLARE k record;
BEGIN
  FOR k IN SELECT rel, conname, def FROM app_panel_slug_keys LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', k.rel, k.conname, k.def);
  END LOOP;
END $$;

-- From here on every id is a slug.
ALTER TABLE ot.custom_apps ADD CONSTRAINT custom_apps_slug_id CHECK ((id COLLATE "C") ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE ot.custom_panels ADD CONSTRAINT custom_panels_slug_id CHECK ((id COLLATE "C") ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
