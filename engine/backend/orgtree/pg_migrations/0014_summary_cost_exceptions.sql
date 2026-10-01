-- The maintained decimal sum covers JSON numbers. Legacy cost_total also
-- accepts truthy numeric strings/bools and rejects other truthy shapes.
-- Retain those exceptional semantics without scanning historical nodes.
CREATE FUNCTION public.orgtree_summary_cost_exception(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $fn$
  SELECT coalesce(jsonb_typeof(value::jsonb->'cost_usd') <> 'number'
    AND value::jsonb->'cost_usd' NOT IN
      ('null'::jsonb,'false'::jsonb,'""'::jsonb,'[]'::jsonb,'{}'::jsonb),false)
$fn$;

CREATE FUNCTION public.orgtree_install_summary_cost_index(p_org_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE s text:='org_'||p_org_id;
BEGIN
  EXECUTE format('CREATE INDEX nodes_summary_cost_exceptions ON %I.nodes(id) '
    'WHERE public.orgtree_summary_cost_exception(val)',s);
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_install_summary_cost_index(bigint) FROM PUBLIC;

DO $migration$
DECLARE org record;
BEGIN
  FOR org IN SELECT org_id FROM public.orgs ORDER BY org_id LOOP
    PERFORM public.orgtree_install_summary_cost_index(org.org_id);
  END LOOP;
END
$migration$;

ALTER FUNCTION public.orgtree_create_org_schema(bigint)
  RENAME TO orgtree_create_org_schema_before_summary_cost;
CREATE FUNCTION public.orgtree_create_org_schema(p_org_id bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE s text;
BEGIN
  s:=public.orgtree_create_org_schema_before_summary_cost(p_org_id);
  PERFORM public.orgtree_install_summary_cost_index(p_org_id);
  RETURN s;
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_create_org_schema(bigint) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='orgtree_runtime') THEN
    REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_summary_cost(bigint) FROM orgtree_runtime;
    GRANT EXECUTE ON FUNCTION public.orgtree_create_org_schema(bigint) TO orgtree_runtime;
  END IF;
END
$grant$;
