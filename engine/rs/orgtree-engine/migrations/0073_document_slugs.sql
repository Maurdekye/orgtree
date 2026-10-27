-- Presentations are identified by a readable slug made from the title, unique
-- in the org and kept when the title changes (user 2026-10-27 m4efbc12ac94e:
-- "identified by a readable slug, not a generic id"). `uid` stays the internal
-- key and an alias: older mail, mentions, notifications and `replaces` that
-- name it keep resolving through ot.document_ref.
ALTER TABLE ot.documents ADD COLUMN slug text CHECK ((slug COLLATE "C") ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
CREATE UNIQUE INDEX documents_slug ON ot.documents (org_id, slug);

-- The title's ASCII letters and digits, lowercased, each run of anything else
-- one '-', cut where util::slugify cuts (at `max_len`, or one later when that
-- character is a '-'); 'presentation' for a title with none of them.
CREATE FUNCTION ot.slug_base(title text, max_len integer) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN s = '' THEN 'presentation'
              WHEN char_length(s) <= max_len OR substr(s, max_len, 1) <> '-' THEN left(s, max_len)
              ELSE left(s, max_len + 1) END
    FROM (SELECT lower(trim(BOTH '-' FROM regexp_replace(title COLLATE "C", '[^A-Za-z0-9]+', '-', 'g'))) AS s) t
$$;

-- The first free slug for a title in an org: the base, then -2, -3, ... on a
-- base cut to 44 characters. An old ID in the org and the `viewed` route
-- segment count as taken, so a new slug never captures an old reference.
-- VOLATILE on purpose: each check reads what committed before it ran.
CREATE FUNCTION ot.document_slug(p_org bigint, p_title text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  base text := ot.slug_base(p_title, 48);
  candidate text := base;
  n integer := 2;
BEGIN
  WHILE candidate = 'viewed' OR EXISTS (SELECT 1 FROM ot.documents d
          WHERE d.org_id = p_org AND (d.slug = candidate OR d.uid = candidate)) LOOP
    candidate := rtrim(left(base, 44), '-') || '-' || n;
    n := n + 1;
  END LOOP;
  RETURN candidate;
END $$;

-- Every insert path (orgtree_present, the importers) gets its slug here, one
-- org at a time, so two presentations with the same title never race.
CREATE FUNCTION ot.assign_document_slug() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('ot.documents.slug/' || NEW.org_id, 0));
    NEW.slug := ot.document_slug(NEW.org_id, NEW.title);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_slug BEFORE INSERT ON ot.documents
  FOR EACH ROW EXECUTE FUNCTION ot.assign_document_slug();

-- Existing presentations, oldest first in each org, so the first of several
-- with one title keeps the plain slug.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, org_id, title FROM ot.documents ORDER BY org_id, id LOOP
    UPDATE ot.documents SET slug = ot.document_slug(r.org_id, r.title) WHERE id = r.id;
  END LOOP;
END $$;
ALTER TABLE ot.documents ALTER COLUMN slug SET NOT NULL;

-- A presentation reference: its slug, else its old ID, in that org only.
CREATE FUNCTION ot.document_ref(p_org bigint, p_ref text) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT id FROM ot.documents WHERE org_id = p_org AND (slug = p_ref OR uid = p_ref)
   ORDER BY slug = p_ref DESC LIMIT 1
$$;
