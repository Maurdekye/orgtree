-- Derived docket metadata only. Raw doc/log_l text remains authoritative.
-- This slice does not change list/authority semantics or enable indexed reads.
CREATE FUNCTION public.orgtree_work_summary(body text) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $fn$
  SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
  FROM json_each(body::json)
  WHERE key = ANY(ARRAY[
    'slug','rev','kind','title','objective','status','owner','reviewer','created_by',
    'at','updated_at','done_so_far','working_on_next','docket_at','last_updater',
    'manual_attention','next_action','objective_notice','post_completion','status_at',
    'superseded_by','parent','legacy_status','blocked_reason','waiting_reason',
    'dropped_reason','participants','archived_at','dependencies','scope_archive_summary',
    'notification_attention_active']);
$fn$;

CREATE FUNCTION public.orgtree_work_index_row() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
DECLARE
  old_key text; new_key text; body text; item json; item_slug text;
  old_location text; new_location text; delta_active integer := 0;
  delta_archive integer := 0; affected bigint;
BEGIN
  IF TG_TABLE_NAME = 'doc' THEN
    IF TG_OP <> 'INSERT' AND starts_with(OLD.key,'work_items' || chr(31)) THEN
      old_key := OLD.key; old_location := 'active';
    END IF;
    IF TG_OP <> 'DELETE' AND starts_with(NEW.key,'work_items' || chr(31)) THEN
      new_key := NEW.key; new_location := 'active'; body := NEW.val;
    END IF;
  ELSE
    IF TG_OP <> 'INSERT' AND OLD.sect = 'work_items_archive' THEN
      old_key := OLD.seq::text; old_location := 'archive';
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.sect = 'work_items_archive' THEN
      new_key := NEW.seq::text; new_location := 'archive'; body := NEW.val;
    END IF;
  END IF;
  IF old_key IS NULL AND new_key IS NULL THEN RETURN NULL; END IF;
  IF old_key IS NOT NULL THEN
    EXECUTE format('DELETE FROM %I.work_index WHERE location=$1 AND source_key=$2',TG_TABLE_SCHEMA)
      USING old_location,old_key;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION 'docket index missing old source %.%',TG_TABLE_SCHEMA,old_key;
    END IF;
    IF old_location='active' THEN delta_active := -1; ELSE delta_archive := -1; END IF;
  END IF;
  IF new_key IS NOT NULL THEN
    item := body::json;
    IF json_typeof(item) IS DISTINCT FROM 'object'
       OR json_typeof(item->'slug') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'docket index refuses invalid item in %',TG_TABLE_SCHEMA;
    END IF;
    item_slug := item->>'slug';
    IF item_slug='' OR strpos(item_slug,chr(31))<>0
       OR (new_location='active' AND new_key <> 'work_items' || chr(31) || item_slug) THEN
      RAISE EXCEPTION 'docket index source/slug mismatch in %',TG_TABLE_SCHEMA;
    END IF;
    EXECUTE format('INSERT INTO %I.work_index(location,source_key,slug,summary,body_sha256) '
                   'VALUES($1,$2,$3,public.orgtree_work_summary($4),sha256(convert_to($4,''UTF8'')))',TG_TABLE_SCHEMA)
      USING new_location,new_key,item_slug,body;
    IF new_location='active' THEN delta_active := delta_active+1; ELSE delta_archive := delta_archive+1; END IF;
  END IF;
  EXECUTE format('UPDATE %I.work_index_state SET active_rows=active_rows+$1, '
                 'archive_rows=archive_rows+$2, revision=revision+1 WHERE singleton',TG_TABLE_SCHEMA)
    USING delta_active,delta_archive;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'docket index missing state in %',TG_TABLE_SCHEMA; END IF;
  RETURN NULL;
END
$fn$;

CREATE FUNCTION public.orgtree_install_work_index(p_org_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE s text := 'org_' || p_org_id;
BEGIN
  -- Never silently accept a partially installed schema.
  EXECUTE format('CREATE TABLE %I.work_index ('
    'location text NOT NULL CHECK(location IN (''active'',''archive'')), '
    'source_key text NOT NULL, slug text NOT NULL, summary jsonb NOT NULL, body_sha256 bytea NOT NULL, '
    'PRIMARY KEY(location,source_key), UNIQUE(slug) DEFERRABLE INITIALLY DEFERRED)',s);
  EXECUTE format('CREATE INDEX work_index_order ON %I.work_index ((summary->>''docket_at''),slug)',s);
  EXECUTE format('CREATE INDEX work_index_status ON %I.work_index ((summary->>''status''),slug)',s);
  EXECUTE format('CREATE TABLE %I.work_index_state ('
    'singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), '
    'format text NOT NULL DEFAULT ''orgtree.work-index/v1'', '
    'active_rows bigint NOT NULL DEFAULT 0 CHECK(active_rows>=0), '
    'archive_rows bigint NOT NULL DEFAULT 0 CHECK(archive_rows>=0), '
    'revision bigint NOT NULL DEFAULT 0, valid boolean NOT NULL DEFAULT false)',s);
  EXECUTE format('INSERT INTO %I.work_index_state(singleton) VALUES(true)',s);
  EXECUTE format('CREATE TRIGGER work_index_doc AFTER INSERT OR UPDATE OR DELETE ON %I.doc '
                 'FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_index_row()',s);
  EXECUTE format('CREATE TRIGGER work_index_log AFTER INSERT OR UPDATE OR DELETE ON %I.log_l '
                 'FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_index_row()',s);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='orgtree_runtime') THEN
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I.work_index,%I.work_index_state TO orgtree_runtime',s,s);
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_install_work_index(bigint) FROM PUBLIC;

-- Recompute from raw rows, not from maintained counters. This is an explicit
-- migration/diagnostic control, never run on an ordinary foreground request.
CREATE FUNCTION public.orgtree_check_work_index(p_org_id bigint) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
DECLARE s text := 'org_' || p_org_id; header json; bad bigint; okay boolean;
BEGIN
  EXECUTE format('SELECT val::json FROM %I.doc WHERE key=''work_items''',s) INTO header;
  IF header IS NOT NULL AND (json_typeof(header) IS DISTINCT FROM 'object'
    OR header->>'format' IS DISTINCT FROM 'orgtree.work-items/v1'
    OR json_typeof(header->'ids') IS DISTINCT FROM 'array') THEN RETURN false; END IF;
  EXECUTE format('SELECT count(*) FROM %I.doc WHERE key=''work_items_archive''',s) INTO bad;
  IF bad<>0 THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM json_array_elements(coalesce(header->'ids','[]'::json)) x
            WHERE json_typeof(x) IS DISTINCT FROM 'string') THEN RETURN false; END IF;
  EXECUTE format('WITH ids AS (SELECT value AS slug FROM json_array_elements_text($1)), '
    'rows AS (SELECT substr(key,12) AS slug FROM %I.doc WHERE starts_with(key,''work_items'' || chr(31))) '
    'SELECT (SELECT count(*)-count(DISTINCT slug) FROM ids)+'
    '(SELECT count(*) FROM (SELECT * FROM ids EXCEPT SELECT * FROM rows) q)+'
    '(SELECT count(*) FROM (SELECT * FROM rows EXCEPT SELECT * FROM ids) q)',s)
    INTO bad USING coalesce(header->'ids','[]'::json);
  IF bad<>0 THEN RETURN false; END IF;
  EXECUTE format('WITH raw AS ('
    'SELECT ''active''::text location,key source_key,val FROM %1$I.doc WHERE starts_with(key,''work_items'' || chr(31)) '
    'UNION ALL SELECT ''archive'',seq::text,val FROM %1$I.log_l WHERE sect=''work_items_archive''), '
    'expected AS (SELECT location,source_key,val::json->>''slug'' slug,public.orgtree_work_summary(val) summary,'
    'sha256(convert_to(val,''UTF8'')) body_sha256 FROM raw) '
    'SELECT NOT EXISTS(SELECT 1 FROM expected e FULL JOIN %1$I.work_index i USING(location,source_key) '
    'WHERE e.slug IS DISTINCT FROM i.slug OR e.summary IS DISTINCT FROM i.summary '
    'OR e.body_sha256 IS DISTINCT FROM i.body_sha256) '
    'AND (SELECT count(*)=1 AND bool_and(format=''orgtree.work-index/v1'' '
    'AND active_rows=(SELECT count(*) FROM raw WHERE location=''active'') '
    'AND archive_rows=(SELECT count(*) FROM raw WHERE location=''archive'')) FROM %1$I.work_index_state)',s)
    INTO okay;
  RETURN coalesce(okay,false);
END
$fn$;

DO $migration$
DECLARE org record; s text; row record; item json; n bigint;
BEGIN
  FOR org IN SELECT org_id FROM public.orgs ORDER BY org_id LOOP
    s := 'org_' || org.org_id;
    EXECUTE format('LOCK TABLE %I.doc,%I.log_l IN ACCESS EXCLUSIVE MODE',s,s);
    PERFORM public.orgtree_install_work_index(org.org_id);
    -- Backfill directly; no UPDATE of authoritative source rows, so other
    -- projections/triggers cannot rewrite source content during migration.
    FOR row IN EXECUTE format('SELECT ''active''::text location,key source_key,val FROM %I.doc '
      'WHERE starts_with(key,''work_items'' || chr(31)) UNION ALL SELECT ''archive'',seq::text,val '
      'FROM %I.log_l WHERE sect=''work_items_archive''',s,s) LOOP
      item := row.val::json;
      IF json_typeof(item) IS DISTINCT FROM 'object' OR json_typeof(item->'slug') IS DISTINCT FROM 'string'
        OR item->>'slug'='' OR strpos(item->>'slug',chr(31))<>0
        OR (row.location='active' AND row.source_key <> 'work_items' || chr(31) || (item->>'slug')) THEN
        RAISE EXCEPTION 'docket migration refuses invalid source in %',s;
      END IF;
      EXECUTE format('INSERT INTO %I.work_index VALUES($1,$2,$3,public.orgtree_work_summary($4),sha256(convert_to($4,''UTF8'')))',s)
        USING row.location,row.source_key,item->>'slug',row.val;
    END LOOP;
    EXECUTE format('UPDATE %1$I.work_index_state SET active_rows=(SELECT count(*) FROM %1$I.work_index WHERE location=''active''),'
                   'archive_rows=(SELECT count(*) FROM %1$I.work_index WHERE location=''archive'')',s);
    IF NOT public.orgtree_check_work_index(org.org_id) THEN
      RAISE EXCEPTION 'docket migration raw/index reconciliation mismatch in %',s;
    END IF;
    -- Force deferred identity checks before marking the index usable.
    SET CONSTRAINTS ALL IMMEDIATE;
    EXECUTE format('UPDATE %I.work_index_state SET valid=true',s);
    INSERT INTO public.receipts(org_id,op_key,result) VALUES(org.org_id,'work-index/v1',
      json_build_object('format','orgtree.work-index/v1','reconciled',true)::text);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='orgtree_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.orgtree_install_work_index(bigint) TO orgtree_runtime;
  END IF;
END
$migration$;

-- Wrap instead of copying the shared creator: keep earlier migrations' schema
-- additions, and cover BOTH engine creation and the offline importer's COPY.
ALTER FUNCTION public.orgtree_create_org_schema(bigint) RENAME TO orgtree_create_org_schema_before_work_index;
CREATE FUNCTION public.orgtree_create_org_schema(p_org_id bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE s text;
BEGIN
  s := public.orgtree_create_org_schema_before_work_index(p_org_id);
  PERFORM public.orgtree_install_work_index(p_org_id);
  IF NOT public.orgtree_check_work_index(p_org_id) THEN
    RAISE EXCEPTION 'new docket index reconciliation failed in %',s;
  END IF;
  EXECUTE format('UPDATE %I.work_index_state SET valid=true',s);
  RETURN s;
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_create_org_schema(bigint) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='orgtree_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.orgtree_create_org_schema(bigint) TO orgtree_runtime;
  END IF;
END
$grant$;
