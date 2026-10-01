-- The tree header's resolved-request history is the MOST RECENTLY RESOLVED
-- ASK_HISTORY_KEEP per section, not the most recently created
-- (docket v3-an-answered-question-vanishes-from-the-inbox): a question left
-- open for a while and then answered must stay in the user's inbox history,
-- however many requests created after it were resolved first.
-- foreground_asks.stamp is coalesce(resolved_at, at) (0004), which is exactly
-- that order. This serves the ORDER BY from an index, so PostgreSQL reads
-- O(ASK_HISTORY_KEEP) rows however many resolved requests the org has kept.
-- Partial on resolved rows only, like 0004's foreground_asks_resolved.
CREATE FUNCTION public.orgtree_install_asks_resolved_recent(p_org_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE s text:='org_'||p_org_id;
BEGIN
  -- Order-independent like 0017: where 0004 has not created the table yet
  -- (it can be applied last, see test_pg_foreground_store), there is nothing
  -- to index; the reader's ORDER BY is still correct, only unindexed.
  IF to_regclass(format('%I.foreground_asks',s)) IS NULL THEN RETURN; END IF;
  EXECUTE format('CREATE INDEX IF NOT EXISTS foreground_asks_resolved_recent ON %I.foreground_asks '
    '(sect, stamp DESC, ord DESC) WHERE status NOT IN (''open'',''pending'')',s);
  -- credit and scope history also hide withdrawn rows (0004's _visible twin)
  EXECUTE format('CREATE INDEX IF NOT EXISTS foreground_asks_resolved_recent_visible ON %I.foreground_asks '
    '(sect, stamp DESC, ord DESC) WHERE status NOT IN (''open'',''pending'') AND status<>''withdrawn''',s);
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_install_asks_resolved_recent(bigint) FROM PUBLIC;

DO $migration$
DECLARE org record;
BEGIN
  FOR org IN SELECT org_id FROM public.orgs ORDER BY org_id LOOP
    PERFORM public.orgtree_install_asks_resolved_recent(org.org_id);
  END LOOP;
END
$migration$;

ALTER FUNCTION public.orgtree_create_org_schema(bigint)
  RENAME TO orgtree_create_org_schema_before_asks_resolved_recent;
CREATE FUNCTION public.orgtree_create_org_schema(p_org_id bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE s text;
BEGIN
  s:=public.orgtree_create_org_schema_before_asks_resolved_recent(p_org_id);
  PERFORM public.orgtree_install_asks_resolved_recent(p_org_id);
  RETURN s;
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_create_org_schema(bigint) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='orgtree_runtime') THEN
    REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_asks_resolved_recent(bigint) FROM orgtree_runtime;
    GRANT EXECUTE ON FUNCTION public.orgtree_create_org_schema(bigint) TO orgtree_runtime;
  END IF;
END
$grant$;
