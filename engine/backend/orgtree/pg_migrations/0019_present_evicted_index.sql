-- The Presentations gallery lists legacy eviction stubs from `present_evicted`
-- events (v3-presentations-window-still-takes-0-5-s-to-ope). Finding them was
-- a text search over EVERY events row: 748 ms and 3,422 pages read on a cold
-- cache over a copy of the live org (49,687 events, 7 matches), which is the
-- half second the first open of the window waited for. Nothing writes this op
-- any more, so the partial index holds a closed handful of rows and other
-- events pay only the predicate on write. The predicate matches
-- store._pg_document_gallery's WHERE clause exactly, which is what lets the
-- planner use it.
CREATE FUNCTION public.orgtree_install_present_evicted(p_org_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE s text:='org_'||p_org_id;
BEGIN
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_log_l_present_evicted ON %I.log_l (seq) '
    'WHERE sect=''events'' AND strpos(val, ''present_evicted'') > 0',s);
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_install_present_evicted(bigint) FROM PUBLIC;

DO $migration$
DECLARE org record;
BEGIN
  FOR org IN SELECT org_id FROM public.orgs ORDER BY org_id LOOP
    PERFORM public.orgtree_install_present_evicted(org.org_id);
  END LOOP;
END
$migration$;

ALTER FUNCTION public.orgtree_create_org_schema(bigint)
  RENAME TO orgtree_create_org_schema_before_present_evicted;
CREATE FUNCTION public.orgtree_create_org_schema(p_org_id bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE s text;
BEGIN
  s:=public.orgtree_create_org_schema_before_present_evicted(p_org_id);
  PERFORM public.orgtree_install_present_evicted(p_org_id);
  RETURN s;
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_create_org_schema(bigint) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='orgtree_runtime') THEN
    REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_present_evicted(bigint) FROM orgtree_runtime;
    GRANT EXECUTE ON FUNCTION public.orgtree_create_org_schema(bigint) TO orgtree_runtime;
  END IF;
END
$grant$;
