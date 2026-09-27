-- Run after COPY and Python-derived bootstrap, not during SQL installation.
CREATE TABLE public.org_statistics_ready (
  org_id bigint PRIMARY KEY REFERENCES public.orgs(org_id) ON DELETE CASCADE,
  schema_version text NOT NULL,
  analyzed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON public.org_statistics_ready FROM PUBLIC;

CREATE FUNCTION public.orgtree_analyze_org(p_org_id bigint, p_force boolean DEFAULT false)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE
  s text := 'org_' || p_org_id;
  version text;
  tab record;
  analyzed integer := 0;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.orgs WHERE org_id=p_org_id) THEN
    RAISE EXCEPTION 'Unknown organization %', p_org_id;
  END IF;
  -- One initializer per org; never mark a failed/interrupted pass complete.
  PERFORM pg_advisory_xact_lock(hashtextextended('orgtree:statistics:' || p_org_id,0));
  SELECT md5(string_agg(name || ':' || sha256, ',' ORDER BY name))
    INTO version FROM public.schema_migrations;
  IF NOT p_force AND EXISTS(SELECT 1 FROM public.org_statistics_ready
      WHERE org_id=p_org_id AND schema_version=version) THEN
    RETURN 0;
  END IF;
  -- Only actual tables in this recorded org's schema. Runtime cannot create
  -- relations there or choose an arbitrary schema/table through this entry.
  FOR tab IN SELECT c.relname FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=s AND c.relkind='r' ORDER BY c.relname LOOP
    EXECUTE format('ANALYZE %I.%I',s,tab.relname);
    analyzed := analyzed + 1;
  END LOOP;
  IF analyzed=0 THEN
    RAISE EXCEPTION 'Organization % has no tables to analyze',p_org_id;
  END IF;
  INSERT INTO public.org_statistics_ready(org_id,schema_version)
    VALUES(p_org_id,version) ON CONFLICT(org_id) DO UPDATE
    SET schema_version=EXCLUDED.schema_version,analyzed_at=clock_timestamp();
  RETURN analyzed;
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_analyze_org(bigint,boolean) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='orgtree_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.orgtree_analyze_org(bigint,boolean) TO orgtree_runtime;
  END IF;
END
$grant$;
