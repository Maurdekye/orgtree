-- The windowed desk chat reads only the newest steered rows of one agent
-- (desk-chat-read-loads-the-agent-s-whole-steered-m). Serve its ORDER BY from
-- an index so PostgreSQL reads O(window) rows however long the agent's
-- steered_log grows. Partial: other log sections pay nothing on write.
-- The expression matches store.log_owner_tail exactly (C collation = the
-- Python str order of the merge; NULL at ranks as '').
CREATE FUNCTION public.orgtree_install_steered_log_tail(p_org_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE s text:='org_'||p_org_id;
BEGIN
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_log_d_steered_tail ON %I.log_d '
    '(owner, (COALESCE(at, '''') COLLATE "C") DESC, seq DESC) '
    'WHERE sect=''steered_log''',s);
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_install_steered_log_tail(bigint) FROM PUBLIC;

DO $migration$
DECLARE org record;
BEGIN
  FOR org IN SELECT org_id FROM public.orgs ORDER BY org_id LOOP
    PERFORM public.orgtree_install_steered_log_tail(org.org_id);
  END LOOP;
END
$migration$;

ALTER FUNCTION public.orgtree_create_org_schema(bigint)
  RENAME TO orgtree_create_org_schema_before_steered_tail;
CREATE FUNCTION public.orgtree_create_org_schema(p_org_id bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE s text;
BEGIN
  s:=public.orgtree_create_org_schema_before_steered_tail(p_org_id);
  PERFORM public.orgtree_install_steered_log_tail(p_org_id);
  RETURN s;
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_create_org_schema(bigint) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='orgtree_runtime') THEN
    REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_steered_tail(bigint) FROM orgtree_runtime;
    GRANT EXECUTE ON FUNCTION public.orgtree_create_org_schema(bigint) TO orgtree_runtime;
  END IF;
END
$grant$;
