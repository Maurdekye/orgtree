-- Add read-only selection hints without changing any authoritative body.
-- Existing summary fields keep their meaning; _query is internal metadata.
ALTER FUNCTION public.orgtree_work_summary(text) RENAME TO orgtree_work_summary_before_query;
CREATE FUNCTION public.orgtree_work_summary(body text) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public AS $fn$
  SELECT public.orgtree_work_summary_before_query(body) || jsonb_build_object('_query',
    jsonb_build_object('format','orgtree.work-query/v1',
      'legacy_identity',body::jsonb ? 'id',
      'order_supported',
        coalesce(jsonb_typeof(body::jsonb->'docket_at'),'null') IN ('null','string') AND
        coalesce(jsonb_typeof(body::jsonb->'updated_at'),'null') IN ('null','string')));
$fn$;

CREATE FUNCTION public.orgtree_install_work_query(p_org_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE s text:='org_'||p_org_id;
BEGIN
  -- C collation gives the same descending lexicographic order as Python.
  EXECUTE format('CREATE INDEX work_query_order ON %I.work_index '
    '((coalesce(nullif(summary->>''docket_at'',''''),summary->>''updated_at'','''') COLLATE "C"), (slug COLLATE "C"))',s);
  EXECUTE format('CREATE INDEX work_query_unsupported ON %I.work_index(slug) WHERE '
    'summary->''_query''->>''format'' IS DISTINCT FROM ''orgtree.work-query/v1'' OR '
    'summary->''_query''->>''legacy_identity'' IS DISTINCT FROM ''false'' OR '
    'summary->''_query''->>''order_supported'' IS DISTINCT FROM ''true''',s);
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_install_work_query(bigint) FROM PUBLIC;

DO $migration$
DECLARE org record; s text;
BEGIN
  FOR org IN SELECT org_id FROM public.orgs ORDER BY org_id LOOP
    s:='org_'||org.org_id;
    EXECUTE format('LOCK TABLE %I.doc,%I.nodes,%I.log_l IN ACCESS EXCLUSIVE MODE',s,s,s);
    -- Existing access triggers deliberately mark each changed summary dirty.
    -- The post-migration Python bootstrap must refresh even initialized rows.
    EXECUTE format('WITH source AS ('
      'SELECT ''active''::text location,key source_key,val FROM %1$I.doc WHERE starts_with(key,''work_items''||chr(31)) '
      'UNION ALL SELECT ''archive'',seq::text,val FROM %1$I.log_l WHERE sect=''work_items_archive'') '
      'UPDATE %1$I.work_index i SET summary=public.orgtree_work_summary(source.val) '
      'FROM source WHERE i.location=source.location AND i.source_key=source.source_key',s);
    PERFORM public.orgtree_install_work_query(org.org_id);
    IF NOT public.orgtree_check_work_index(org.org_id) THEN
      RAISE EXCEPTION 'docket query migration reconciliation failed in %',s;
    END IF;
  END LOOP;
END
$migration$;

ALTER FUNCTION public.orgtree_create_org_schema(bigint) RENAME TO orgtree_create_org_schema_before_work_query;
CREATE FUNCTION public.orgtree_create_org_schema(p_org_id bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE s text;
BEGIN
  s:=public.orgtree_create_org_schema_before_work_query(p_org_id);
  PERFORM public.orgtree_install_work_query(p_org_id);
  RETURN s;
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_create_org_schema(bigint) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='orgtree_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.orgtree_install_work_query(bigint) TO orgtree_runtime;
    GRANT EXECUTE ON FUNCTION public.orgtree_create_org_schema(bigint) TO orgtree_runtime;
  END IF;
END
$grant$;
