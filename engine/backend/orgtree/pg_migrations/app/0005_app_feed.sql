-- The app registry has complete snapshots, not an org-style change log.
CREATE TABLE orgtree.app_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  app_uuid uuid NOT NULL DEFAULT gen_random_uuid(),
  incarnation uuid NOT NULL DEFAULT gen_random_uuid()
);
INSERT INTO orgtree.app_identity DEFAULT VALUES;

CREATE TABLE orgtree.registry_revision (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  rev bigint NOT NULL DEFAULT 0 CHECK (rev >= 0)
);
INSERT INTO orgtree.registry_revision DEFAULT VALUES;

-- All source rows and immediate FK checks precede this lock. No source
-- lookup or source-row lock follows it. The local setting rolls back with a
-- savepoint, just like the singleton update, and expires at transaction end.
CREATE FUNCTION orgtree.registry_flush() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE r bigint;
BEGIN
  IF nullif(current_setting('orgtree.registry_revision', true), '') IS NULL THEN
    UPDATE orgtree.registry_revision SET rev=rev+1 RETURNING rev INTO r;
    PERFORM set_config('orgtree.registry_revision', r::text, true);
    PERFORM pg_notify('app_rev', r::text);
  END IF;
  RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER registry_flush AFTER INSERT OR UPDATE OR DELETE ON orgtree.orgs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orgtree.registry_flush();

CREATE FUNCTION orgtree.registry_defer() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
BEGIN
  SET CONSTRAINTS orgtree.registry_flush DEFERRED;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER registry_defer BEFORE INSERT OR UPDATE OR DELETE ON orgtree.orgs
  FOR EACH STATEMENT EXECUTE FUNCTION orgtree.registry_defer();
