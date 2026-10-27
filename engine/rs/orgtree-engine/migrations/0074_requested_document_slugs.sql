-- orgtree_present may ask for a slug (user 2026-10-27 mdcb7ce9a8103: "Add the
-- field (recommended)"), in English when the title isn't (mea228250b31e: "just
-- encourage agents to use an english name for the slug, the actual name can be
-- whatever it needs to be in any language"). A slug given on insert is a
-- request: it gets the title's cleanup and clash suffixes under the same per-org
-- lock, so the database still makes every slug. One that the cleanup leaves
-- empty is refused, never turned into `presentation`; orgtree_present refuses it
-- first with its own message.
CREATE OR REPLACE FUNCTION ot.assign_document_slug() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ot.documents.slug/' || NEW.org_id, 0));
  IF NEW.slug IS NULL THEN
    NEW.slug := ot.document_slug(NEW.org_id, NEW.title);
  ELSIF (NEW.slug COLLATE "C") !~ '[A-Za-z0-9]' THEN
    RAISE EXCEPTION 'a requested presentation slug needs an ASCII letter or digit: %', NEW.slug
      USING ERRCODE = 'invalid_parameter_value';
  ELSE
    NEW.slug := ot.document_slug(NEW.org_id, NEW.slug);
  END IF;
  RETURN NEW;
END $$;
