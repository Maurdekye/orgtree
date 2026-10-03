--
-- PostgreSQL database dump
--

\restrict yGwm1duBn04f49xMYrpD2YIaZbvWg5BpMTktu77GxOkv862aJ3FOuFpQ01ESA3M

-- Dumped from database version 18.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: org_1; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA org_1;


--
-- Name: org_2; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA org_2;


--
-- Name: json_extract(text, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.json_extract(v text, VARIADIC paths text[]) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE WHEN array_length(paths, 1) = 1 THEN (
           SELECT CASE jsonb_typeof(x) WHEN 'string' THEN x #>> '{}'
                                        WHEN 'null' THEN NULL ELSE x::text END
           FROM (SELECT v::jsonb #> string_to_array(substr(paths[1], 3), '.') AS x) q)
         ELSE (SELECT jsonb_agg(v::jsonb #> string_to_array(substr(p, 3), '.') ORDER BY o)::text
               FROM unnest(paths) WITH ORDINALITY AS t(p, o))
         END
$$;


--
-- Name: orgtree_analyze_org(bigint, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_analyze_org(p_org_id bigint, p_force boolean DEFAULT false) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  s text := 'org_' || p_org_id;
  version text;
  table_names text[];
  table_name text;
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
  SELECT array_agg(c.relname::text ORDER BY c.relname) INTO table_names
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=s AND c.relkind='r';
  IF coalesce(cardinality(table_names),0)=0 THEN
    RAISE EXCEPTION 'Organization % has no tables to analyze',p_org_id;
  END IF;
  FOREACH table_name IN ARRAY table_names LOOP
    EXECUTE format('ANALYZE %I.%I',s,table_name);
    analyzed := analyzed + 1;
  END LOOP;
  IF analyzed<>cardinality(table_names) THEN
    RAISE EXCEPTION 'Incomplete statistics for organization %: % of % tables',
      p_org_id,analyzed,cardinality(table_names);
  END IF;
  INSERT INTO public.org_statistics_ready(org_id,schema_version)
    VALUES(p_org_id,version) ON CONFLICT(org_id) DO UPDATE
    SET schema_version=EXCLUDED.schema_version,analyzed_at=clock_timestamp();
  RETURN analyzed;
END
$$;


--
-- Name: orgtree_check_work_index(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_check_work_index(p_org_id bigint) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE s text := 'org_' || p_org_id; header json; bad bigint; okay boolean;
BEGIN
  EXECUTE format('SELECT val::json FROM %I.doc WHERE key=''work_items''',s) INTO header;
  IF header IS NOT NULL AND (json_typeof(header) IS DISTINCT FROM 'object'
    OR header->>'format' IS DISTINCT FROM 'orgtree.work-items/v1'
    OR json_typeof(header->'ids') IS DISTINCT FROM 'array'
    OR (SELECT array_agg(key ORDER BY key) FROM json_object_keys(header) key) <> ARRAY['format','ids']) THEN RETURN false; END IF;
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
$_$;


--
-- Name: orgtree_create_org_schema(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_create_org_schema(p_org_id bigint) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE s text;
BEGIN
  s:=public.orgtree_create_org_schema_before_present_evicted(p_org_id);
  PERFORM public.orgtree_install_present_evicted(p_org_id);
  RETURN s;
END
$$;


--
-- Name: orgtree_create_org_schema_before_asks_resolved_recent(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_create_org_schema_before_asks_resolved_recent(p_org_id bigint) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE s text;
BEGIN
  s:=public.orgtree_create_org_schema_before_tree_val(p_org_id);
  PERFORM public.orgtree_install_tree_val(p_org_id);
  RETURN s;
END
$$;


--
-- Name: orgtree_create_org_schema_before_mail_bounds(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_create_org_schema_before_mail_bounds(p_org_id bigint) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE s text;
BEGIN
 s:=public.orgtree_create_org_schema_v3(p_org_id);
 PERFORM public.orgtree_install_foreground_index(p_org_id);
 RETURN s;
END
$$;


--
-- Name: orgtree_create_org_schema_before_mail_sent(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_create_org_schema_before_mail_sent(p_org_id bigint) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
$$;


--
-- Name: orgtree_create_org_schema_before_policy_candidates(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_create_org_schema_before_policy_candidates(p_org_id bigint) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE s text;
BEGIN
  s:=public.orgtree_create_org_schema_before_work_query(p_org_id);
  PERFORM public.orgtree_install_work_query(p_org_id);
  RETURN s;
END
$$;


--
-- Name: orgtree_create_org_schema_before_present_evicted(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_create_org_schema_before_present_evicted(p_org_id bigint) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE s text;
BEGIN
  s:=public.orgtree_create_org_schema_before_asks_resolved_recent(p_org_id);
  PERFORM public.orgtree_install_asks_resolved_recent(p_org_id);
  RETURN s;
END
$$;


--
-- Name: orgtree_create_org_schema_before_receipts(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_create_org_schema_before_receipts(p_org_id bigint) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE s text;
BEGIN
  s:=public.orgtree_create_org_schema_before_work_list(p_org_id);
  PERFORM public.orgtree_install_work_list(p_org_id);
  RETURN s;
END
$$;


--
-- Name: orgtree_create_org_schema_before_steered_tail(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_create_org_schema_before_steered_tail(p_org_id bigint) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE s text;
BEGIN
  s:=public.orgtree_create_org_schema_before_summary_cost(p_org_id);
  PERFORM public.orgtree_install_summary_cost_index(p_org_id);
  RETURN s;
END
$$;


--
-- Name: orgtree_create_org_schema_before_summary_cost(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_create_org_schema_before_summary_cost(p_org_id bigint) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE s text;
BEGIN
  s := public.orgtree_create_org_schema_before_receipts(p_org_id);
  PERFORM public.orgtree_install_receipt_rows(p_org_id);
  RETURN s;
END
$$;


--
-- Name: orgtree_create_org_schema_before_tree_val(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_create_org_schema_before_tree_val(p_org_id bigint) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE s text;
BEGIN
  s:=public.orgtree_create_org_schema_before_steered_tail(p_org_id);
  PERFORM public.orgtree_install_steered_log_tail(p_org_id);
  RETURN s;
END
$$;


--
-- Name: orgtree_create_org_schema_before_work_access(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_create_org_schema_before_work_access(p_org_id bigint) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE s text;
BEGIN
  s := public.orgtree_create_org_schema_before_mail_sent(p_org_id);
  PERFORM public.orgtree_install_mail_sent(p_org_id);
  RETURN s;
END
$$;


--
-- Name: orgtree_create_org_schema_before_work_index(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_create_org_schema_before_work_index(p_org_id bigint) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE s text;
BEGIN
  s := public.orgtree_create_org_schema_before_mail_bounds(p_org_id);
  PERFORM public.orgtree_install_mail_bounds(p_org_id);
  RETURN s;
END
$$;


--
-- Name: orgtree_create_org_schema_before_work_list(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_create_org_schema_before_work_list(p_org_id bigint) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE s text;
BEGIN
  s := public.orgtree_create_org_schema_before_policy_candidates(p_org_id);
  PERFORM public.orgtree_install_policy_candidates(p_org_id);
  RETURN s;
END
$$;


--
-- Name: orgtree_create_org_schema_before_work_query(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_create_org_schema_before_work_query(p_org_id bigint) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE s text;
BEGIN
  s:=public.orgtree_create_org_schema_before_work_access(p_org_id);
  PERFORM public.orgtree_install_work_access(p_org_id);
  RETURN s;
END
$$;


--
-- Name: orgtree_create_org_schema_v3(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_create_org_schema_v3(p_org_id bigint) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE s text := 'org_' || p_org_id;
BEGIN
  EXECUTE format('CREATE SCHEMA %I', s);
  EXECUTE format('CREATE TABLE %I.doc (key text PRIMARY KEY, val text NOT NULL)', s);
  EXECUTE format('CREATE TABLE %I.nodes (id text PRIMARY KEY, ord integer NOT NULL, val text NOT NULL)', s);
  EXECUTE format('CREATE TABLE %I.log_d (seq bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, '
                 'sect text NOT NULL, owner text NOT NULL, at text, val text NOT NULL)', s);
  EXECUTE format('CREATE INDEX ix_log_d ON %I.log_d (sect, owner, seq)', s);
  EXECUTE format('CREATE TABLE %I.log_l (seq bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, '
                 'sect text NOT NULL, at text, val text NOT NULL)', s);
  EXECUTE format('CREATE INDEX ix_log_l ON %I.log_l (sect, seq)', s);
  EXECUTE format('CREATE TABLE %I.meta (key text PRIMARY KEY, val text NOT NULL)', s);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orgtree_runtime') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO orgtree_runtime', s);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO orgtree_runtime', s);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO orgtree_runtime', s);
  END IF;
  RETURN s;
END
$$;


--
-- Name: orgtree_delete_receipt(bigint, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_delete_receipt(p_org_id bigint, p_owner text, p_token text, p_expected text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $_$
DECLARE s text := 'org_' || p_org_id; marker integer; old_value text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.orgs WHERE org_id=p_org_id) THEN
    RAISE EXCEPTION 'Unknown organization %',p_org_id;
  END IF;
  IF p_owner IS NULL OR p_owner='' OR p_token IS NULL OR p_token='' OR p_expected IS NULL THEN
    RAISE EXCEPTION 'Receipt deletion requires an exact baseline';
  END IF;
  EXECUTE format('SELECT format FROM %I.receipt_format WHERE singleton',s) INTO marker;
  IF marker IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Custody receipt conversion incomplete'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(s),hashtext('receipt-owner:'||p_owner));
  EXECUTE format('SELECT owner FROM %I.receipt_owners WHERE owner=$1 FOR UPDATE',s) USING p_owner;
  EXECUTE format('SELECT val FROM %I.receipts WHERE owner=$1 AND token=$2 FOR UPDATE',s)
    INTO old_value USING p_owner,p_token;
  IF old_value IS NULL THEN RETURN false; END IF;
  IF old_value IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'Stale custody receipt deletion' USING ERRCODE='40001';
  END IF;
  EXECUTE format('DELETE FROM %I.receipt_carriers WHERE owner=$1 AND token=$2',s) USING p_owner,p_token;
  EXECUTE format('DELETE FROM %I.receipts WHERE owner=$1 AND token=$2',s) USING p_owner,p_token;
  EXECUTE format('UPDATE %I.receipt_owners SET nrows=nrows-1,version=nextval(%L::regclass) WHERE owner=$1',s,s||'.receipt_owner_versions')
    USING p_owner;
  RETURN true;
END
$_$;


--
-- Name: orgtree_foreground_doc(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_foreground_doc(s text, k text, value text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
BEGIN
 IF k IN ('asks','credit_requests','scope_requests') THEN
   IF value IS NULL THEN
     EXECUTE format('DELETE FROM %I.foreground_asks WHERE sect=$1',s) USING k;
   ELSE
     EXECUTE format($sql$
       INSERT INTO %I.foreground_asks(sect,ord,node,status,stamp,val)
       -- These are derivative lookup keys, not new source constraints.
       -- Legacy asks may omit node/status; preserve their raw value so the
       -- canonical reader can request exact compatibility instead of aborting
       -- a save or a populated-root backfill with NOT NULL violation.
       SELECT $1,ord,coalesce(v->>'node',''),coalesce(v->>'status',''),
              coalesce(v->>'resolved_at',v->>'at',''),v::text
       FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS r(v,ord)
       ON CONFLICT(sect,ord) DO UPDATE SET node=excluded.node,status=excluded.status,
         stamp=excluded.stamp,val=excluded.val
       WHERE (foreground_asks.node,foreground_asks.status,foreground_asks.stamp,foreground_asks.val)
         IS DISTINCT FROM (excluded.node,excluded.status,excluded.stamp,excluded.val)
     $sql$,s) USING k,value;
     EXECUTE format('DELETE FROM %I.foreground_asks WHERE sect=$1 AND ord>jsonb_array_length($2::jsonb)',s)
       USING k,value;
   END IF;
 ELSIF k='documents' THEN
   -- Compatibility for a pre-rowed section: one normalized metadata index,
   -- never parse the historical document bodies on a foreground read.
   EXECUTE format('DELETE FROM %I.foreground_documents WHERE source=1',s);
   EXECUTE format('DELETE FROM %I.foreground_counts WHERE source=1 AND sect=''documents''',s);
   IF value IS NOT NULL THEN
     EXECUTE format('INSERT INTO %I.foreground_documents(source,seq,node,meta) '
       'SELECT 1,ord,v->>''node'',public.orgtree_foreground_document(v) '
       'FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY r(v,ord)',s) USING value;
     EXECUTE format('INSERT INTO %I.foreground_counts SELECT 1,''documents'',node,count(*) '
       'FROM %I.foreground_documents WHERE source=1 GROUP BY node',s,s);
   END IF;
 ELSIF k='org_inbox' THEN
   IF value IS NULL THEN
     EXECUTE format('DELETE FROM %I.foreground_blobs WHERE key=$1',s) USING k;
   ELSE
     EXECUTE format($sql$
       INSERT INTO %I.foreground_blobs(key,val)
       SELECT $1,jsonb_build_object('total',jsonb_array_length($2::jsonb),'entries',
         coalesce((SELECT jsonb_agg(v ORDER BY ord) FROM
           jsonb_array_elements($2::jsonb) WITH ORDINALITY r(v,ord)
           WHERE ord>jsonb_array_length($2::jsonb)-3),'[]'::jsonb))
       ON CONFLICT(key) DO UPDATE SET val=excluded.val
     $sql$,s) USING k,value;
   END IF;
 END IF;
END
$_$;


--
-- Name: orgtree_foreground_doc_commit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_foreground_doc_commit() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
 IF TG_OP='UPDATE' AND (OLD.key,OLD.val) IS NOT DISTINCT FROM (NEW.key,NEW.val)
 THEN RETURN NULL; END IF;
 -- A direct committed settings write must invalidate a response even when
 -- it does not use the Python save hook/public org revision. This counter is
 -- cheap and conservative; content revisions still suppress unchanged wire.
 EXECUTE format('UPDATE %I.foreground_meta SET view_revision=view_revision+1 WHERE singleton=1',TG_TABLE_SCHEMA);
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.key<>NEW.key) THEN
   PERFORM public.orgtree_foreground_doc(TG_TABLE_SCHEMA,OLD.key,NULL);
 END IF;
 IF TG_OP<>'DELETE' THEN
   PERFORM public.orgtree_foreground_doc(TG_TABLE_SCHEMA,NEW.key,NEW.val);
 END IF;
 RETURN NULL;
END
$$;


--
-- Name: orgtree_foreground_document(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_foreground_document(value jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    AS $$
 SELECT jsonb_build_object('id',value->'id','title',value->'title','at',value->'at',
                          'format',coalesce(nullif(value->>'format',''),'markdown'))
$$;


--
-- Name: orgtree_foreground_lineage(text, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_foreground_lineage(s text, changed text[]) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
BEGIN
 -- Only predecessor/state/bearer/generation changes enter here. Status, cost,
 -- session and charter updates never traverse historical lineage.
 EXECUTE format($sql$
   WITH RECURSIVE affected(id) AS (
     SELECT id FROM %1$I.node_index WHERE $1 IS NULL
     UNION
     SELECT unnest($1)
     UNION
     SELECT n.id FROM %1$I.node_index n JOIN affected a
       ON n.meta->>'predecessor'=a.id
   ), chain(origin,id,depth,path) AS (
     SELECT n.id,p.id,1,ARRAY[n.id,p.id]
       FROM %1$I.node_index n JOIN affected a ON a.id=n.id
       JOIN %1$I.node_index p ON p.id=n.meta->>'predecessor'
       WHERE p.id<>n.id
     UNION ALL
     SELECT c.origin,p.id,c.depth+1,c.path||p.id
       FROM chain c JOIN %1$I.node_index n ON n.id=c.id
       JOIN %1$I.node_index p ON p.id=n.meta->>'predecessor'
       WHERE NOT p.id=ANY(c.path)
   ), counted AS (
     SELECT a.id,count(c.id) AS count,
       (SELECT x.id FROM chain x JOIN %1$I.node_index p ON p.id=x.id
        WHERE x.origin=a.id AND p.meta->>'state'='archived'
          AND coalesce(p.meta->>'bearer_state','')<>'lost'
        ORDER BY (p.meta->>'generation')::numeric DESC,x.depth LIMIT 1) AS consult
     FROM affected a LEFT JOIN chain c ON c.origin=a.id GROUP BY a.id
   ) UPDATE %1$I.node_index n SET lineage_count=c.count,consult_id=c.consult
     FROM counted c WHERE n.id=c.id
       AND (n.lineage_count,n.consult_id) IS DISTINCT FROM (c.count,c.consult)
 $sql$,s) USING changed;
END
$_$;


--
-- Name: orgtree_foreground_log_commit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_foreground_log_commit() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE s text:=TG_TABLE_SCHEMA; os text; ns text; oo text; no text; ov jsonb; nv jsonb;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.sect,OLD.seq,OLD.val) IS NOT DISTINCT FROM (NEW.sect,NEW.seq,NEW.val)
 THEN RETURN NULL; END IF;
 IF (TG_OP<>'INSERT' AND OLD.sect IN ('documents','org_inbox','user_inbox','work_items_archive','work_scope_log',
                                    'audiences','audience_requests','watchdogs','watchdog_tombs'))
    OR (TG_OP<>'DELETE' AND NEW.sect IN ('documents','org_inbox','user_inbox','work_items_archive','work_scope_log',
                                      'audiences','audience_requests','watchdogs','watchdog_tombs')) THEN
   EXECUTE format('UPDATE %I.foreground_meta SET view_revision=view_revision+1 WHERE singleton=1',s);
 END IF;
 IF TG_OP<>'INSERT' AND OLD.sect IN ('documents','org_inbox') THEN
   os:=OLD.sect;
   oo:=CASE WHEN os='documents' THEN OLD.val::jsonb->>'node' ELSE '' END;
 END IF;
 IF TG_OP<>'DELETE' AND NEW.sect IN ('documents','org_inbox') THEN
   ns:=NEW.sect;
   no:=CASE WHEN ns='documents' THEN NEW.val::jsonb->>'node' ELSE '' END;
 END IF;
 IF os IS NULL AND ns IS NULL THEN RETURN NULL; END IF;
 EXECUTE format($sql$
   INSERT INTO %I.foreground_counts(source,sect,owner,total)
   SELECT 0,sect,owner,sum(delta) FROM (VALUES($1,$2,-1),($3,$4,1)) r(sect,owner,delta)
   WHERE sect IS NOT NULL GROUP BY sect,owner HAVING sum(delta)<>0 ORDER BY sect,owner
   ON CONFLICT(source,sect,owner) DO UPDATE SET total=foreground_counts.total+excluded.total
 $sql$,s) USING os,oo,ns,no;
 IF os='documents' THEN
   EXECUTE format('DELETE FROM %I.foreground_documents WHERE source=0 AND seq=$1',s) USING OLD.seq;
 END IF;
 IF ns='documents' THEN
   EXECUTE format('INSERT INTO %I.foreground_documents(source,seq,node,meta) VALUES(0,$1,$2,$3)',s)
     USING NEW.seq,no,public.orgtree_foreground_document(NEW.val::jsonb);
 END IF;
 RETURN NULL;
END
$_$;


--
-- Name: orgtree_foreground_meta(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_foreground_meta(n jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
 SELECT jsonb_build_object(
   'parent',coalesce(n->>'parent',''),
   'state',coalesce(n->>'state','live'),
   'title',coalesce(n->>'title',''),
   'model',coalesce(n->>'model',''),
   'grant',n->'grant',
   'order',CASE WHEN jsonb_typeof(n->'ui_order')='number' THEN n->'ui_order' ELSE '0'::jsonb END,
   'created',coalesce(n->>'created',''),
   'predecessor',coalesce(n->>'predecessor',''),
   'successor',coalesce(n->>'successor',''),
   'generation',CASE WHEN jsonb_typeof(n->'generation')='number' THEN n->'generation' ELSE '0'::jsonb END,
   'bearer_state',n->'bearer_state',
   'session_id',n->'session_id',
   'transcript_incarnation',n->'transcript_incarnation',
   'reply_incarnation',n->'reply_incarnation',
   'cost',CASE WHEN jsonb_typeof(n->'cost_usd')='number' THEN n->'cost_usd' ELSE '0'::jsonb END,
   'cost_unknown',coalesce(n->'cost_usd_unknown','false'::jsonb))
$$;


--
-- Name: orgtree_foreground_node_commit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_foreground_node_commit() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE
 s text:=TG_TABLE_SCHEMA; oldm jsonb; newm jsonb;
 old_id text; new_id text; old_retired boolean:=false; new_retired boolean:=false;
 catalog_changed boolean; lineage_changed boolean;
 old_cost numeric:=0; new_cost numeric:=0;
 old_unknown bigint:=0; new_unknown bigint:=0; affected bigint;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.ord,OLD.val) IS NOT DISTINCT FROM (NEW.id,NEW.ord,NEW.val)
 THEN RETURN NULL; END IF;
 IF TG_OP<>'INSERT' THEN
   old_id:=OLD.id; oldm:=public.orgtree_foreground_meta(OLD.val::jsonb);
   old_retired:=oldm->>'state'='archived' AND oldm->>'successor'='';
   old_cost:=(oldm->>'cost')::numeric;
   old_unknown:=CASE WHEN oldm->>'cost_unknown'='true' THEN 1 ELSE 0 END;
 END IF;
 IF TG_OP<>'DELETE' THEN
   new_id:=NEW.id; newm:=public.orgtree_foreground_meta(NEW.val::jsonb);
   new_retired:=newm->>'state'='archived' AND newm->>'successor'='';
   new_cost:=(newm->>'cost')::numeric;
   new_unknown:=CASE WHEN newm->>'cost_unknown'='true' THEN 1 ELSE 0 END;
 END IF;
 catalog_changed:=TG_OP<>'UPDATE' OR OLD.id IS DISTINCT FROM NEW.id
   OR OLD.ord IS DISTINCT FROM NEW.ord
   OR (oldm-ARRAY['cost','cost_unknown','grant','session_id','transcript_incarnation','reply_incarnation'])
      IS DISTINCT FROM
      (newm-ARRAY['cost','cost_unknown','grant','session_id','transcript_incarnation','reply_incarnation']);
 lineage_changed:=TG_OP<>'UPDATE' OR OLD.id IS DISTINCT FROM NEW.id
   OR (oldm->'predecessor',oldm->'state',oldm->'bearer_state',oldm->'generation')
      IS DISTINCT FROM
      (newm->'predecessor',newm->'state',newm->'bearer_state',newm->'generation');
 -- This is a DEFERRED constraint trigger. Writers have finished their node
 -- writes (and normal saves hold public.orgs' commit-revision row) before this
 -- shared metadata row is locked. Do not turn this into a per-statement lock.
 EXECUTE format('UPDATE %I.foreground_meta SET node_revision=node_revision+1, '
   'catalog_revision=catalog_revision+$1,node_count=node_count+$2, '
   'retired_axis_count=retired_axis_count+$3,cost=cost+$4,cost_unknown=cost_unknown+$5 WHERE singleton=1',s)
   USING catalog_changed::integer,
     CASE TG_OP WHEN 'INSERT' THEN 1 WHEN 'DELETE' THEN -1 ELSE 0 END,
     new_retired::integer-old_retired::integer,new_cost-old_cost,new_unknown-old_unknown;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 THEN RAISE EXCEPTION 'foreground metadata missing in %',s; END IF;
 IF old_retired IS DISTINCT FROM new_retired
    OR oldm->>'parent' IS DISTINCT FROM newm->>'parent' THEN
   EXECUTE format($sql$
     INSERT INTO %I.foreground_parents(parent,retired_children)
     SELECT parent,sum(delta) FROM (VALUES ($1,$2::bigint),($3,$4::bigint)) d(parent,delta)
     WHERE parent IS NOT NULL AND delta<>0 GROUP BY parent ORDER BY parent
     ON CONFLICT(parent) DO UPDATE SET retired_children=foreground_parents.retired_children+excluded.retired_children
   $sql$,s) USING oldm->>'parent',-old_retired::integer,newm->>'parent',new_retired::integer;
 END IF;
 IF TG_OP='DELETE' OR old_id IS DISTINCT FROM new_id THEN
   EXECUTE format('DELETE FROM %I.node_index WHERE id=$1',s) USING old_id;
 END IF;
 IF TG_OP<>'DELETE' THEN
   EXECUTE format('INSERT INTO %I.node_index(id,ord,meta) VALUES($1,$2,$3) '
     'ON CONFLICT(id) DO UPDATE SET ord=excluded.ord,meta=excluded.meta '
     'WHERE (node_index.ord,node_index.meta) IS DISTINCT FROM (excluded.ord,excluded.meta)',s)
     USING NEW.id,NEW.ord,newm;
 END IF;
 IF lineage_changed THEN
   PERFORM public.orgtree_foreground_lineage(s,array_remove(ARRAY[old_id,new_id],NULL));
 END IF;
 RETURN NULL;
END
$_$;


--
-- Name: orgtree_foreground_tree_val(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_foreground_tree_val(v text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $_$
DECLARE j jsonb;
BEGIN
 IF v ~ '[:,\[]-?[0-9]+(\.[0-9]+)?[eE]|[:,\[]-0\.0[,}\]]' THEN RETURN NULL; END IF;
 j:=v::jsonb;
 IF jsonb_typeof(j->'turns')='array' AND jsonb_array_length(j->'turns')>8 THEN
   RETURN jsonb_set(j,'{turns}',jsonb_path_query_array(j,'$.turns[last - 7 to last]'))::text;
 END IF;
 RETURN NULL;
END
$_$;


--
-- Name: orgtree_foreground_tree_val_commit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_foreground_tree_val_commit() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE s text:=TG_TABLE_SCHEMA; trimmed text;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.val) IS NOT DISTINCT FROM (NEW.id,NEW.val)
 THEN RETURN NULL; END IF;
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.id<>NEW.id) THEN
   EXECUTE format('DELETE FROM %I.node_tree_val WHERE id=$1',s) USING OLD.id;
 END IF;
 IF TG_OP<>'DELETE' THEN
   trimmed:=public.orgtree_foreground_tree_val(NEW.val);
   IF trimmed IS NULL THEN
     EXECUTE format('DELETE FROM %I.node_tree_val WHERE id=$1',s) USING NEW.id;
   ELSE
     EXECUTE format('INSERT INTO %I.node_tree_val(id,val) VALUES($1,$2) '
       'ON CONFLICT(id) DO UPDATE SET val=excluded.val WHERE node_tree_val.val IS DISTINCT FROM excluded.val',s)
       USING NEW.id,trimmed;
   END IF;
 END IF;
 RETURN NULL;
END
$_$;


--
-- Name: orgtree_id_grams(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_id_grams(value text) RETURNS text[]
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
 SELECT coalesce(array_agg(DISTINCT substr(lower(value), p, width)),ARRAY[]::text[])
 FROM generate_series(1,3) width,
      LATERAL generate_series(1,length(value)-width+1) p
$$;


--
-- Name: orgtree_install_asks_resolved_recent(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_install_asks_resolved_recent(p_org_id bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
$$;


--
-- Name: orgtree_install_foreground_index(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_install_foreground_index(p_org_id bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE s text:='org_'||p_org_id; item record;
BEGIN
 EXECUTE format('CREATE TABLE %I.node_index (id text PRIMARY KEY,ord integer NOT NULL, '
   'meta jsonb NOT NULL,lineage_count bigint NOT NULL DEFAULT 0,consult_id text)',s);
 EXECUTE format('CREATE INDEX node_index_active ON %I.node_index(ord,id) '
   'WHERE meta->>''state''<>''archived''',s);
 EXECUTE format('CREATE INDEX node_index_children ON %I.node_index '
   '((meta->>''parent''),((meta->>''order'')::numeric),(meta->>''created''),ord,id) '
   'WHERE meta->>''state''=''archived'' AND meta->>''successor''=''''',s);
 EXECUTE format('CREATE INDEX node_index_predecessor ON %I.node_index((meta->>''predecessor''))',s);
 EXECUTE format('CREATE INDEX node_index_discovery ON %I.node_index((meta->>''state''),(id COLLATE "C"))',s);
 EXECUTE format('CREATE INDEX node_index_search ON %I.node_index USING gin(public.orgtree_id_grams(id))',s);
 EXECUTE format('CREATE TABLE %I.foreground_parents(parent text PRIMARY KEY,retired_children bigint NOT NULL)',s);
 EXECUTE format('CREATE TABLE %I.foreground_meta(singleton integer PRIMARY KEY CHECK(singleton=1), '
   'node_revision bigint NOT NULL,catalog_revision bigint NOT NULL,node_count bigint NOT NULL, '
   'view_revision bigint NOT NULL DEFAULT 0, '
   'retired_axis_count bigint NOT NULL,cost numeric NOT NULL,cost_unknown bigint NOT NULL)',s);
 EXECUTE format('INSERT INTO %I.node_index(id,ord,meta) '
   'SELECT id,ord,public.orgtree_foreground_meta(val::jsonb) FROM %I.nodes',s,s);
 EXECUTE format('INSERT INTO %I.foreground_meta SELECT 1,0,0,count(*),0, '
   'count(*) FILTER (WHERE meta->>''state''=''archived'' AND meta->>''successor''=''''), '
   'coalesce(sum((meta->>''cost'')::numeric),0),count(*) FILTER (WHERE meta->>''cost_unknown''=''true'') '
   'FROM %I.node_index',s,s);
 EXECUTE format('INSERT INTO %I.foreground_parents SELECT meta->>''parent'',count(*) FROM %I.node_index '
   'WHERE meta->>''state''=''archived'' AND meta->>''successor''='''' GROUP BY meta->>''parent''',s,s);
 PERFORM public.orgtree_foreground_lineage(s,NULL);
 EXECUTE format('CREATE CONSTRAINT TRIGGER foreground_node_commit AFTER INSERT OR UPDATE OR DELETE '
   'ON %I.nodes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW '
   'EXECUTE FUNCTION public.orgtree_foreground_node_commit()',s);
 EXECUTE format('CREATE TABLE %I.foreground_asks(sect text NOT NULL,ord bigint NOT NULL,node text NOT NULL, '
   'status text NOT NULL,stamp text NOT NULL,val text NOT NULL,PRIMARY KEY(sect,ord))',s);
 EXECUTE format('CREATE INDEX foreground_asks_open ON %I.foreground_asks(sect,ord) '
   'WHERE status IN (''open'',''pending'')',s);
 EXECUTE format('CREATE INDEX foreground_asks_resolved ON %I.foreground_asks(sect,ord DESC) '
   'WHERE status NOT IN (''open'',''pending'')',s);
 EXECUTE format('CREATE INDEX foreground_asks_resolved_visible ON %I.foreground_asks(sect,ord DESC) '
   'WHERE status NOT IN (''open'',''pending'') AND status<>''withdrawn''',s);
 EXECUTE format('CREATE INDEX foreground_asks_node ON %I.foreground_asks(node,sect,stamp DESC,ord)',s);
 EXECUTE format('CREATE INDEX foreground_asks_not_withdrawn ON %I.foreground_asks(node,sect,stamp DESC,ord) '
   'WHERE status<>''withdrawn''',s);
 EXECUTE format('CREATE TABLE %I.foreground_counts(source smallint NOT NULL,sect text NOT NULL, '
   'owner text NOT NULL,total bigint NOT NULL,PRIMARY KEY(source,sect,owner))',s);
 EXECUTE format('CREATE TABLE %I.foreground_documents(source smallint NOT NULL,seq bigint NOT NULL, '
   'node text NOT NULL,meta jsonb NOT NULL,PRIMARY KEY(source,seq))',s);
 EXECUTE format('CREATE INDEX foreground_documents_node ON %I.foreground_documents(source,node,seq)',s);
 EXECUTE format('CREATE TABLE %I.foreground_blobs(key text PRIMARY KEY,val jsonb NOT NULL)',s);
 EXECUTE format('INSERT INTO %I.foreground_counts SELECT 0,sect, '
   'CASE WHEN sect=''documents'' THEN val::jsonb->>''node'' ELSE '''' END,count(*) '
   'FROM %I.log_l WHERE sect IN (''documents'',''org_inbox'') GROUP BY 2,3',s,s);
 EXECUTE format('INSERT INTO %I.foreground_documents SELECT 0,seq,val::jsonb->>''node'', '
   'public.orgtree_foreground_document(val::jsonb) FROM %I.log_l WHERE sect=''documents''',s,s);
 FOR item IN EXECUTE format('SELECT key,val FROM %I.doc WHERE key IN '
   '(''asks'',''credit_requests'',''scope_requests'',''documents'',''org_inbox'')',s) LOOP
   PERFORM public.orgtree_foreground_doc(s,item.key,item.val);
 END LOOP;
 EXECUTE format('CREATE CONSTRAINT TRIGGER foreground_doc_commit AFTER INSERT OR UPDATE OR DELETE '
   'ON %I.doc DEFERRABLE INITIALLY DEFERRED FOR EACH ROW '
   'EXECUTE FUNCTION public.orgtree_foreground_doc_commit()',s);
 EXECUTE format('CREATE CONSTRAINT TRIGGER foreground_log_commit AFTER INSERT OR UPDATE OR DELETE '
   'ON %I.log_l DEFERRABLE INITIALLY DEFERRED FOR EACH ROW '
   'EXECUTE FUNCTION public.orgtree_foreground_log_commit()',s);
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='orgtree_runtime') THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I.node_index,%I.foreground_meta,%I.foreground_parents TO orgtree_runtime',s,s,s);
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I.foreground_asks,%I.foreground_counts, '
     '%I.foreground_documents,%I.foreground_blobs TO orgtree_runtime',s,s,s,s);
 END IF;
END
$$;


--
-- Name: orgtree_install_mail_bounds(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_install_mail_bounds(org_id bigint) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE s text := 'org_' || org_id; recipient text; source_n bigint; summary_n bigint;
BEGIN
  EXECUTE format('LOCK TABLE %I.log_d IN ACCESS EXCLUSIVE MODE',s);
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I.mail_archive_bounds('
                 'owner text PRIMARY KEY,nrows bigint NOT NULL CHECK(nrows>=0),'
                 'unknown_rows bigint NOT NULL CHECK(unknown_rows>=0 AND unknown_rows<=nrows),'
                 'assigned_max numeric NOT NULL CHECK(assigned_max>=0),'
                 'version bigint NOT NULL,format integer NOT NULL)',s);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='orgtree_runtime') THEN
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I.mail_archive_bounds TO orgtree_runtime',s);
  END IF;
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_mail_ordinal ON %I.log_d '
                 '(owner,public.orgtree_mail_ordinal(val) DESC) WHERE sect=''mail_log''',s);
  EXECUTE format('DROP TRIGGER IF EXISTS mail_archive_bounds ON %I.log_d',s);
  EXECUTE format('DROP TRIGGER IF EXISTS mail_archive_prepare ON %I.log_d',s);
  EXECUTE format('CREATE TRIGGER mail_archive_prepare BEFORE INSERT OR UPDATE OR DELETE ON %I.log_d '
                 'FOR EACH ROW EXECUTE FUNCTION public.orgtree_track_mail_archive()',s);
  EXECUTE format('CREATE TRIGGER mail_archive_bounds AFTER INSERT OR UPDATE OR DELETE ON %I.log_d '
                 'FOR EACH ROW EXECUTE FUNCTION public.orgtree_track_mail_archive()',s);
  EXECUTE format('DROP TRIGGER IF EXISTS mail_archive_truncate ON %I.log_d',s);
  EXECUTE format('CREATE TRIGGER mail_archive_truncate AFTER TRUNCATE ON %I.log_d '
                 'FOR EACH STATEMENT EXECUTE FUNCTION public.orgtree_truncate_mail_archive()',s);
  -- Re-running rebuilds only derived data and is safe after an interrupted
  -- migration or a restored source snapshot. Never trust a version marker alone.
  EXECUTE format('DELETE FROM %I.mail_archive_bounds',s);
  FOR recipient IN EXECUTE format('SELECT id FROM %I.nodes UNION '
                     'SELECT owner FROM %I.log_d WHERE sect=''mail_log''',s,s)
  LOOP
    PERFORM public.orgtree_reconcile_mail_owner(s,recipient);
  END LOOP;
  EXECUTE format('SELECT count(*) FROM %I.log_d WHERE sect=''mail_log''',s) INTO source_n;
  EXECUTE format('SELECT coalesce(sum(nrows),0) FROM %I.mail_archive_bounds',s) INTO summary_n;
  IF source_n <> summary_n THEN RAISE EXCEPTION 'mail archive reconciliation mismatch in %',s; END IF;
END
$$;


--
-- Name: orgtree_install_mail_sent(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_install_mail_sent(org_id bigint) RETURNS void
    LANGUAGE plpgsql
    AS $_$
DECLARE s text := 'org_' || org_id; source_n bigint; index_n bigint;
BEGIN
  EXECUTE format('LOCK TABLE %I.log_d IN ACCESS EXCLUSIVE MODE',s);
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I.mail_sent('
                 'seq bigint PRIMARY KEY,owner text NOT NULL,sender text,'
                 'sent_at text NOT NULL,owner_pos bigint NOT NULL)',s);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='orgtree_runtime') THEN
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I.mail_sent TO orgtree_runtime',s);
  END IF;
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_mail_sent_tail ON %I.mail_sent '
                 '(sender,sent_at DESC,owner_pos DESC,seq DESC)',s);
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_mail_sent_owner ON %I.mail_sent(owner,seq)',s);
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_user_mail_sender ON %I.log_l '
                 '(public.json_extract(val,''$.from''),'
                 '(coalesce(public.json_extract(val,''$.at''),'''')) DESC,seq DESC) '
                 'WHERE sect=''user_mail_log''',s);
  EXECUTE format('DROP TRIGGER IF EXISTS mail_sent_update ON %I.log_d',s);
  EXECUTE format('CREATE TRIGGER mail_sent_update AFTER INSERT OR UPDATE OR DELETE ON %I.log_d '
                 'FOR EACH ROW EXECUTE FUNCTION public.orgtree_track_mail_sent()',s);
  EXECUTE format('DROP TRIGGER IF EXISTS mail_sent_truncate ON %I.log_d',s);
  EXECUTE format('CREATE TRIGGER mail_sent_truncate AFTER TRUNCATE ON %I.log_d '
                 'FOR EACH STATEMENT EXECUTE FUNCTION public.orgtree_truncate_mail_sent()',s);
  EXECUTE format('TRUNCATE %I.mail_sent',s);
  EXECUTE format('INSERT INTO %I.mail_sent(seq,owner,sender,sent_at,owner_pos) '
                 'SELECT seq,owner,public.json_extract(val,''$.from''),'
                 'coalesce(public.json_extract(val,''$.at''),''''),'
                 'min(seq) OVER(PARTITION BY owner) FROM %I.log_d WHERE sect=''mail_log''',s,s);
  EXECUTE format('SELECT count(*) FROM %I.log_d WHERE sect=''mail_log''',s) INTO source_n;
  EXECUTE format('SELECT count(*) FROM %I.mail_sent',s) INTO index_n;
  IF source_n <> index_n THEN RAISE EXCEPTION 'Sent index reconciliation mismatch in %',s; END IF;
END
$_$;


--
-- Name: orgtree_install_policy_candidates(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_install_policy_candidates(p_org_id bigint) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $_$
DECLARE s text := 'org_' || p_org_id;
BEGIN
  EXECUTE format($sql$
    CREATE INDEX IF NOT EXISTS ix_policy_candidates ON %I.nodes(ord,id)
    WHERE val::jsonb->>'state'='live' OR
      coalesce(val::jsonb->'frozen','null'::jsonb) NOT IN
        ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb,'[]'::jsonb,'{}'::jsonb)
  $sql$,s);
  EXECUTE format($sql$
    CREATE INDEX IF NOT EXISTS ix_policy_settings ON %I.doc(key)
    WHERE strpos(key,chr(31))=0 AND key NOT IN (
      'nodes','work_items','mail','delivering','notices','mail_log','steered_log',
      'turn_error_log','steer_attempts','work_scope_log','events','org_inbox',
      'notice_log','user_mail_log','user_outbox','documents','watchdog_history',
      'op_receipts','work_items_archive','lifecycle','watchdogs','watchdog_tombs',
      'reservations','credit_requests')
  $sql$,s);
END
$_$;


--
-- Name: orgtree_install_present_evicted(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_install_present_evicted(p_org_id bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE s text:='org_'||p_org_id;
BEGIN
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_log_l_present_evicted ON %I.log_l (seq) '
    'WHERE sect=''events'' AND strpos(val, ''present_evicted'') > 0',s);
END
$$;


--
-- Name: orgtree_install_receipt_rows(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_install_receipt_rows(p_org_id bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE s text := 'org_' || p_org_id;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.orgs WHERE org_id=p_org_id) THEN
    RAISE EXCEPTION 'Unknown organization %',p_org_id;
  END IF;
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I.receipt_format('
    'singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),'
    'format integer NOT NULL CHECK(format=1),present boolean NOT NULL,'
    'conversion_sha256 text NOT NULL,converted_owners bigint NOT NULL,'
    'converted_receipts bigint NOT NULL,converted_carriers bigint NOT NULL)',s);
  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I.receipt_owner_versions',s);
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I.receipt_owners('
    'owner text PRIMARY KEY,ord bigint GENERATED BY DEFAULT AS IDENTITY(START WITH 0 MINVALUE 0),'
    'nrows bigint NOT NULL DEFAULT 0 CHECK(nrows>=0),next_ord bigint NOT NULL DEFAULT 0 CHECK(next_ord>=0),'
    'version bigint NOT NULL DEFAULT nextval(%L::regclass),'
    'UNIQUE(ord))',s,s||'.receipt_owner_versions');
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I.receipts('
    'owner text NOT NULL REFERENCES %I.receipt_owners(owner),token text NOT NULL,'
    'ord bigint NOT NULL CHECK(ord>=0),val text NOT NULL,version bigint NOT NULL DEFAULT 1,'
    'PRIMARY KEY(owner,token),UNIQUE(owner,ord))',s,s);
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I.receipt_carriers('
    'owner text NOT NULL,carrier text NOT NULL,token text NOT NULL,'
    'PRIMARY KEY(owner,carrier,token),FOREIGN KEY(owner,token) REFERENCES %I.receipts(owner,token))',s,s);
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_receipt_carriers_operation ON %I.receipt_carriers(owner,token)',s);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='orgtree_runtime') THEN
    -- Explicit conversion/replacement runs through the same runtime transaction.
    -- Ordinary append callers use orgtree_put_receipt below.
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON '
      '%I.receipt_format,%I.receipt_owners,%I.receipts,%I.receipt_carriers TO orgtree_runtime',s,s,s,s);
    EXECUTE format('GRANT USAGE,SELECT,UPDATE ON SEQUENCE %I.receipt_owners_ord_seq,%I.receipt_owner_versions TO orgtree_runtime',s,s);
  END IF;
END
$$;


--
-- Name: orgtree_install_steered_log_tail(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_install_steered_log_tail(p_org_id bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE s text:='org_'||p_org_id;
BEGIN
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_log_d_steered_tail ON %I.log_d '
    '(owner, (COALESCE(at, '''') COLLATE "C") DESC, seq DESC) '
    'WHERE sect=''steered_log''',s);
END
$$;


--
-- Name: orgtree_install_summary_cost_index(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_install_summary_cost_index(p_org_id bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE s text:='org_'||p_org_id;
BEGIN
  EXECUTE format('CREATE INDEX nodes_summary_cost_exceptions ON %I.nodes(id) '
    'WHERE public.orgtree_summary_cost_exception(val)',s);
END
$$;


--
-- Name: orgtree_install_tree_val(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_install_tree_val(p_org_id bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE s text:='org_'||p_org_id;
BEGIN
 EXECUTE format('CREATE TABLE IF NOT EXISTS %I.node_tree_val(id text PRIMARY KEY,val text NOT NULL)',s);
 EXECUTE format('DELETE FROM %I.node_tree_val t WHERE NOT EXISTS '
   '(SELECT 1 FROM %I.nodes n WHERE n.id=t.id AND public.orgtree_foreground_tree_val(n.val) IS NOT NULL)',s,s);
 EXECUTE format('INSERT INTO %I.node_tree_val(id,val) '
   'SELECT id,v FROM (SELECT id,public.orgtree_foreground_tree_val(val) v FROM %I.nodes) d WHERE v IS NOT NULL '
   'ON CONFLICT(id) DO UPDATE SET val=excluded.val WHERE node_tree_val.val IS DISTINCT FROM excluded.val',s,s);
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
               JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
               WHERE n.nspname=s AND c.relname='nodes' AND t.tgname='foreground_tree_val_commit') THEN
   EXECUTE format('CREATE CONSTRAINT TRIGGER foreground_tree_val_commit AFTER INSERT OR UPDATE OR DELETE '
     'ON %I.nodes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW '
     'EXECUTE FUNCTION public.orgtree_foreground_tree_val_commit()',s);
 END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='orgtree_runtime') THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I.node_tree_val TO orgtree_runtime',s);
 END IF;
END
$$;


--
-- Name: orgtree_install_work_access(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_install_work_access(p_org_id bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE s text:='org_'||p_org_id;
BEGIN
  EXECUTE format('CREATE TABLE %I.work_read_state(singleton boolean PRIMARY KEY CHECK(singleton), '
    'format text NOT NULL DEFAULT ''orgtree.work-access/v1'', initialized boolean NOT NULL DEFAULT false,'
    'ready boolean NOT NULL DEFAULT false, questions_dirty boolean NOT NULL DEFAULT true, revision bigint NOT NULL DEFAULT 0)',s);
  EXECUTE format('INSERT INTO %I.work_read_state(singleton) VALUES(true)',s);
  EXECUTE format('CREATE TABLE %I.work_read_dirty(slug text PRIMARY KEY)',s);
  EXECUTE format('CREATE TABLE %I.work_read_policy(slug text PRIMARY KEY, location text NOT NULL, '
    'deadline double precision, manual boolean NOT NULL)',s);
  EXECUTE format('CREATE INDEX work_read_forever ON %I.work_read_policy(slug) WHERE location=''active'' AND deadline IS NULL',s);
  EXECUTE format('CREATE INDEX work_read_deadline ON %I.work_read_policy(deadline,slug) WHERE location=''active'' AND deadline IS NOT NULL',s);
  EXECUTE format('CREATE INDEX work_read_manual ON %I.work_read_policy(slug) WHERE manual',s);
  EXECUTE format('CREATE TABLE %I.work_read_access(slug text NOT NULL,viewer text NOT NULL,PRIMARY KEY(slug,viewer))',s);
  EXECUTE format('CREATE INDEX work_read_viewer ON %I.work_read_access(viewer,slug)',s);
  EXECUTE format('CREATE TABLE %I.work_read_totals(viewer text PRIMARY KEY,total bigint NOT NULL CHECK(total>=0))',s);
  EXECUTE format('CREATE TABLE %I.work_read_dependency(slug text NOT NULL,node_id text NOT NULL,PRIMARY KEY(slug,node_id))',s);
  EXECUTE format('CREATE INDEX work_read_node ON %I.work_read_dependency(node_id,slug)',s);
  EXECUTE format('CREATE TABLE %I.work_read_questions(slug text PRIMARY KEY,questions jsonb NOT NULL)',s);
  EXECUTE format('INSERT INTO %1$I.work_read_dirty SELECT slug FROM %1$I.work_index',s);
  EXECUTE format('CREATE TRIGGER work_access_item AFTER INSERT OR UPDATE OR DELETE ON %I.work_index '
    'FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_access_dirty()',s);
  EXECUTE format('CREATE TRIGGER work_access_node AFTER INSERT OR UPDATE OR DELETE ON %I.nodes '
    'FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_access_dirty()',s);
  EXECUTE format('CREATE TRIGGER work_access_doc AFTER INSERT OR UPDATE OR DELETE ON %I.doc '
    'FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_access_dirty()',s);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='orgtree_runtime') THEN
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %1$I.work_read_state,%1$I.work_read_dirty,'
      '%1$I.work_read_policy,%1$I.work_read_access,%1$I.work_read_totals,%1$I.work_read_dependency,'
      '%1$I.work_read_questions TO orgtree_runtime',s);
  END IF;
END
$_$;


--
-- Name: orgtree_install_work_index(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_install_work_index(p_org_id bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
$$;


--
-- Name: orgtree_install_work_list(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_install_work_list(p_org_id bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE s text:='org_'||p_org_id;
BEGIN
  EXECUTE format('CREATE TABLE %I.work_list_state(singleton boolean PRIMARY KEY CHECK(singleton),'
    'format text NOT NULL DEFAULT ''orgtree.work-list/v1'', initialized boolean NOT NULL DEFAULT false,'
    'ready boolean NOT NULL DEFAULT false, revision bigint NOT NULL DEFAULT 0)',s);
  EXECUTE format('INSERT INTO %I.work_list_state(singleton) VALUES(true)',s);
  EXECUTE format('CREATE TABLE %I.work_list_dirty(slug text PRIMARY KEY)',s);
  EXECUTE format('CREATE TABLE %I.work_list_summary(slug text PRIMARY KEY,body_sha256 bytea NOT NULL,payload jsonb NOT NULL)',s);
  EXECUTE format('INSERT INTO %1$I.work_list_dirty SELECT slug FROM %1$I.work_index',s);
  EXECUTE format('CREATE TRIGGER work_list_item AFTER INSERT OR UPDATE OR DELETE ON %I.work_index '
    'FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_list_dirty()',s);
  EXECUTE format('CREATE TRIGGER work_list_scope AFTER INSERT OR UPDATE OR DELETE ON %I.log_d '
    'FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_list_dirty()',s);
  EXECUTE format('CREATE TRIGGER work_list_node AFTER INSERT OR UPDATE OR DELETE ON %I.nodes '
    'FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_list_dirty()',s);
  EXECUTE format('CREATE TRIGGER work_list_doc AFTER INSERT OR UPDATE OR DELETE ON %I.doc '
    'FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_list_dirty()',s);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='orgtree_runtime') THEN
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %1$I.work_list_state,%1$I.work_list_dirty,%1$I.work_list_summary TO orgtree_runtime',s);
  END IF;
END
$_$;


--
-- Name: orgtree_install_work_query(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_install_work_query(p_org_id bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
$$;


--
-- Name: orgtree_mail_ordinal(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_mail_ordinal(v text) RETURNS numeric
    LANGUAGE sql IMMUTABLE
    AS $_$
  SELECT CASE WHEN json_typeof(v::json->'recv_seq') = 'number'
                   AND (v::json->>'recv_seq') ~ '^[1-9][0-9]*$'
              THEN (v::json->>'recv_seq')::numeric ELSE 0 END
$_$;


--
-- Name: orgtree_mail_unknown(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_mail_unknown(v text) RETURNS bigint
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE WHEN json_typeof(v::json) IS DISTINCT FROM 'object' THEN 1
              WHEN v::json->'recv_seq' IS NOT NULL
                   AND public.orgtree_mail_ordinal(v) = 0 THEN 1 ELSE 0 END
$$;


--
-- Name: orgtree_put_receipt(bigint, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_put_receipt(p_org_id bigint, p_owner text, p_token text, p_value text, p_expected text DEFAULT NULL::text) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $_$
DECLARE s text := 'org_' || p_org_id; payload json; old_value text; old_version bigint;
        total bigint; position bigint; next_version bigint; entry record; marker integer;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.orgs WHERE org_id=p_org_id) THEN
    RAISE EXCEPTION 'Unknown organization %',p_org_id;
  END IF;
  payload := p_value::json;
  IF p_owner IS NULL OR p_owner='' OR p_token IS NULL OR p_token=''
     OR json_typeof(payload) IS DISTINCT FROM 'object'
     OR payload->>'node' IS DISTINCT FROM p_owner
     OR payload->>'operation' IS DISTINCT FROM p_token
     OR payload->>'outcome' IS NULL OR payload->>'outcome' NOT IN ('confirmed','reclaimed')
     OR json_typeof(payload->'before') IS DISTINCT FROM 'object'
     OR json_typeof(payload->'identity') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Unsupported custody receipt';
  END IF;
  IF json_array_length(payload->'identity')<>3
     OR EXISTS(SELECT key FROM json_each(payload) GROUP BY key HAVING count(*)>1)
     OR EXISTS(SELECT key FROM json_each(payload->'before') GROUP BY key HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Ambiguous custody receipt';
  END IF;
  EXECUTE format('SELECT format FROM %I.receipt_format WHERE singleton',s) INTO marker;
  IF marker IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Custody receipt conversion incomplete'; END IF;
  -- Fixed order: owner advisory -> owner summary row -> affected receipt.
  -- Callers changing several owners acquire these in sorted owner order.
  PERFORM pg_advisory_xact_lock(hashtext(s),hashtext('receipt-owner:'||p_owner));
  EXECUTE format('SELECT nrows FROM %I.receipt_owners WHERE owner=$1',s) INTO total USING p_owner;
  IF total IS NULL THEN
    EXECUTE format('INSERT INTO %I.receipt_owners(owner) VALUES($1)',s) USING p_owner;
  END IF;
  EXECUTE format('SELECT nrows,next_ord FROM %I.receipt_owners WHERE owner=$1 FOR UPDATE',s)
    INTO total,position USING p_owner;
  EXECUTE format('SELECT val,version FROM %I.receipts WHERE owner=$1 AND token=$2 FOR UPDATE',s)
    INTO old_value,old_version USING p_owner,p_token;
  IF old_value=p_value THEN RETURN old_version; END IF;
  IF old_value IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Stale custody receipt' USING ERRCODE='40001'; END IF;
  IF old_value IS NULL THEN
    EXECUTE format('INSERT INTO %I.receipts(owner,token,ord,val) VALUES($1,$2,$3,$4) RETURNING version',s)
      INTO next_version USING p_owner,p_token,position,p_value;
    EXECUTE format('UPDATE %I.receipt_owners SET nrows=nrows+1,next_ord=next_ord+1,version=nextval(%L::regclass) WHERE owner=$1',s,s||'.receipt_owner_versions')
      USING p_owner;
  ELSE
    EXECUTE format('UPDATE %I.receipts SET val=$3,version=version+1 WHERE owner=$1 AND token=$2 RETURNING version',s)
      INTO next_version USING p_owner,p_token,p_value;
    EXECUTE format('DELETE FROM %I.receipt_carriers WHERE owner=$1 AND token=$2',s)
      USING p_owner,p_token;
    EXECUTE format('UPDATE %I.receipt_owners SET version=nextval(%L::regclass) WHERE owner=$1',s,s||'.receipt_owner_versions') USING p_owner;
  END IF;
  FOR entry IN SELECT key,value FROM json_each_text(payload->'before') LOOP
    IF entry.key='' OR entry.value IS NULL OR entry.value !~ '^[0-9a-f]{64}$'
       OR json_typeof(payload->'before'->entry.key) IS DISTINCT FROM 'string'
    THEN RAISE EXCEPTION 'Unsupported carrier fingerprint'; END IF;
    EXECUTE format('INSERT INTO %I.receipt_carriers(owner,carrier,token) VALUES($1,$2,$3)',s)
      USING p_owner,entry.key,p_token;
  END LOOP;
  -- Only the first append to an absent section changes its presence marker.
  EXECUTE format('UPDATE %I.receipt_format SET present=true WHERE singleton AND NOT present',s);
  RETURN next_version;
END
$_$;


--
-- Name: orgtree_reconcile_mail_owner(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_reconcile_mail_owner(s text, recipient text) RETURNS void
    LANGUAGE plpgsql
    AS $_$
DECLARE n bigint; bad bigint; high numeric; written bigint;
BEGIN
  EXECUTE format('SELECT count(*), coalesce(sum(public.orgtree_mail_unknown(val)),0), '
                 'coalesce(max(public.orgtree_mail_ordinal(val)),0) FROM %I.log_d '
                 'WHERE sect=''mail_log'' AND owner=$1',s)
    INTO n,bad,high USING recipient;
  EXECUTE format('INSERT INTO %I.mail_archive_bounds(owner,nrows,unknown_rows,assigned_max,version,format) '
                 'VALUES($1,$2,$3,$4,1,1) ON CONFLICT(owner) DO UPDATE SET '
                 'nrows=excluded.nrows,unknown_rows=excluded.unknown_rows,assigned_max=excluded.assigned_max,'
                 'version=mail_archive_bounds.version+1,format=1 RETURNING nrows',s)
    INTO written USING recipient,n,bad,high;
  IF written <> n THEN RAISE EXCEPTION 'mail archive count mismatch in % for %',s,recipient; END IF;
END
$_$;


--
-- Name: orgtree_summary_cost_exception(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_summary_cost_exception(value text) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT coalesce(jsonb_typeof(value::jsonb->'cost_usd') <> 'number'
    AND value::jsonb->'cost_usd' NOT IN
      ('null'::jsonb,'false'::jsonb,'""'::jsonb,'[]'::jsonb,'{}'::jsonb),false)
$$;


--
-- Name: orgtree_track_mail_archive(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_track_mail_archive() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE recipient text; old_n bigint; old_bad bigint; old_max numeric; found_format integer;
        delta_n bigint; delta_bad bigint; added numeric; removed numeric; high numeric;
BEGIN
  -- A mailbox advisory lock also covers the first row, absent from the summary.
  -- Initialize BEFORE mutation, count actual changes AFTER mutation. COPY can
  -- expose a whole statement to AFTER row triggers; a rebuild there would
  -- double-count. Counting BEFORE would count ON CONFLICT DO NOTHING as a row.
  FOR recipient IN
    SELECT DISTINCT x FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' AND OLD.sect='mail_log' THEN OLD.owner END,
      CASE WHEN TG_OP <> 'DELETE' AND NEW.sect='mail_log' THEN NEW.owner END]) x
    WHERE x IS NOT NULL ORDER BY x
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA),hashtext('mail-bound:'||recipient));
    EXECUTE format('SELECT nrows,unknown_rows,assigned_max,format FROM %I.mail_archive_bounds '
                   'WHERE owner=$1 FOR UPDATE',TG_TABLE_SCHEMA)
      INTO old_n,old_bad,old_max,found_format USING recipient;
    IF old_n IS NULL OR found_format <> 1 THEN
      IF TG_WHEN <> 'BEFORE' THEN RAISE EXCEPTION 'mail archive bound lost during mutation'; END IF;
      PERFORM public.orgtree_reconcile_mail_owner(TG_TABLE_SCHEMA,recipient);
      EXECUTE format('SELECT nrows,unknown_rows,assigned_max FROM %I.mail_archive_bounds '
                     'WHERE owner=$1',TG_TABLE_SCHEMA)
        INTO old_n,old_bad,old_max USING recipient;
    END IF;
    IF TG_WHEN='BEFORE' THEN CONTINUE; END IF;
    delta_n:=0; delta_bad:=0; added:=0; removed:=0;
    IF TG_OP <> 'INSERT' AND OLD.sect='mail_log' AND OLD.owner=recipient THEN
      delta_n:=delta_n-1; delta_bad:=delta_bad-public.orgtree_mail_unknown(OLD.val);
      removed:=public.orgtree_mail_ordinal(OLD.val);
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.sect='mail_log' AND NEW.owner=recipient THEN
      delta_n:=delta_n+1; delta_bad:=delta_bad+public.orgtree_mail_unknown(NEW.val);
      added:=public.orgtree_mail_ordinal(NEW.val);
    END IF;
    high:=greatest(old_max,added);
    IF removed >= high AND removed > 0 THEN
      EXECUTE format('SELECT public.orgtree_mail_ordinal(val) FROM %I.log_d '
                     'WHERE sect=''mail_log'' AND owner=$1 AND seq<>$2 '
                     'ORDER BY public.orgtree_mail_ordinal(val) DESC LIMIT 1',TG_TABLE_SCHEMA)
        INTO high USING recipient,OLD.seq;
      high:=greatest(coalesce(high,0),added);
    END IF;
    EXECUTE format('UPDATE %I.mail_archive_bounds SET nrows=nrows+$2,unknown_rows=unknown_rows+$3,'
                   'assigned_max=$4,version=version+1 WHERE owner=$1',TG_TABLE_SCHEMA)
      USING recipient,delta_n,delta_bad,high;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END
$_$;


--
-- Name: orgtree_track_mail_sent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_track_mail_sent() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE recipient text; first_seq bigint; indexed_first bigint;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.sect='mail_log' THEN
    EXECUTE format('DELETE FROM %I.mail_sent WHERE seq=$1',TG_TABLE_SCHEMA) USING OLD.seq;
  END IF;
  -- Appends leave first_seq unchanged: two indexed first-row lookups, no
  -- history walk. Removing/moving a first row repairs only that owner's keys.
  -- COPY/statement updates may expose all final source rows to AFTER triggers.
  FOR recipient IN
    SELECT DISTINCT x FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' AND OLD.sect='mail_log' THEN OLD.owner END,
      CASE WHEN TG_OP <> 'DELETE' AND NEW.sect='mail_log' THEN NEW.owner END]) x
    WHERE x IS NOT NULL ORDER BY x
  LOOP
    EXECUTE format('SELECT seq FROM %I.log_d WHERE sect=''mail_log'' AND owner=$1 '
                   'ORDER BY seq LIMIT 1',TG_TABLE_SCHEMA) INTO first_seq USING recipient;
    IF first_seq IS NULL THEN
      EXECUTE format('DELETE FROM %I.mail_sent WHERE owner=$1',TG_TABLE_SCHEMA) USING recipient;
    ELSE
      EXECUTE format('SELECT owner_pos FROM %I.mail_sent WHERE owner=$1 ORDER BY seq LIMIT 1',
                     TG_TABLE_SCHEMA) INTO indexed_first USING recipient;
      IF indexed_first IS DISTINCT FROM first_seq THEN
        EXECUTE format('UPDATE %I.mail_sent SET owner_pos=$2 WHERE owner=$1',TG_TABLE_SCHEMA)
          USING recipient,first_seq;
      END IF;
    END IF;
  END LOOP;
  IF TG_OP <> 'DELETE' AND NEW.sect='mail_log' THEN
    EXECUTE format('SELECT seq FROM %I.log_d WHERE sect=''mail_log'' AND owner=$1 '
                   'ORDER BY seq LIMIT 1',TG_TABLE_SCHEMA) INTO first_seq USING NEW.owner;
    EXECUTE format('INSERT INTO %I.mail_sent(seq,owner,sender,sent_at,owner_pos) '
                   'VALUES($1,$2,$3,$4,$5)',TG_TABLE_SCHEMA)
      USING NEW.seq,NEW.owner,public.json_extract(NEW.val,'$.from'),
            coalesce(public.json_extract(NEW.val,'$.at'),''),first_seq;
  END IF;
  RETURN NULL;
END
$_$;


--
-- Name: orgtree_truncate_mail_archive(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_truncate_mail_archive() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  EXECUTE format('UPDATE %I.mail_archive_bounds SET nrows=0,unknown_rows=0,assigned_max=0,version=version+1',
                 TG_TABLE_SCHEMA);
  RETURN NULL;
END
$$;


--
-- Name: orgtree_truncate_mail_sent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_truncate_mail_sent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  EXECUTE format('TRUNCATE %I.mail_sent',TG_TABLE_SCHEMA);
  RETURN NULL;
END
$$;


--
-- Name: orgtree_work_access_dirty(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_work_access_dirty() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE s text:=TG_TABLE_SCHEMA; old_id text; new_id text;
BEGIN
  IF TG_TABLE_NAME='nodes' THEN
    IF TG_OP='UPDATE' AND OLD.id=NEW.id
      AND OLD.val::jsonb->'parent' IS NOT DISTINCT FROM NEW.val::jsonb->'parent' THEN RETURN NULL; END IF;
    IF TG_OP<>'INSERT' THEN old_id:=OLD.id; END IF;
    IF TG_OP<>'DELETE' THEN new_id:=NEW.id; END IF;
  ELSIF TG_TABLE_NAME='doc' THEN
    IF TG_OP='UPDATE' AND OLD.key=NEW.key AND OLD.val=NEW.val THEN RETURN NULL; END IF;
    IF TG_OP<>'INSERT' THEN old_id:=OLD.key; END IF;
    IF TG_OP<>'DELETE' THEN new_id:=NEW.key; END IF;
    IF coalesce(old_id,'') NOT IN ('asks','nodes','work_items','work_items_archive') AND coalesce(new_id,'') NOT IN ('asks','nodes','work_items','work_items_archive') THEN RETURN NULL; END IF;
  ELSE
    IF TG_OP<>'INSERT' THEN old_id:=OLD.slug; END IF;
    IF TG_OP<>'DELETE' THEN new_id:=NEW.slug; END IF;
  END IF;
  -- Serialize relevant writers BEFORE observing dependency rows. A concurrent
  -- owner write and reparent must see the earlier writer's committed metadata.
  EXECUTE format('UPDATE %I.work_read_state SET revision=revision+1 WHERE singleton',s);
  IF TG_TABLE_NAME='nodes' THEN
    EXECUTE format('INSERT INTO %1$I.work_read_dirty(slug) SELECT DISTINCT slug FROM %1$I.work_read_dependency '
      'WHERE node_id=$1 OR node_id=$2 ON CONFLICT DO NOTHING',s) USING old_id,new_id;
  ELSIF TG_TABLE_NAME='doc' THEN
    EXECUTE format('UPDATE %I.work_read_state SET questions_dirty=true WHERE singleton',s);
    -- Blob topology is a compatibility layout. Never certify derived access.
    IF old_id IN ('nodes','work_items_archive') OR new_id IN ('nodes','work_items_archive') THEN
      EXECUTE format('UPDATE %I.work_read_state SET ready=false WHERE singleton',s);
    END IF;
  ELSE
    EXECUTE format('INSERT INTO %I.work_read_dirty(slug) SELECT DISTINCT x FROM unnest(ARRAY[$1,$2]) x '
      'WHERE x IS NOT NULL ON CONFLICT DO NOTHING',s) USING old_id,new_id;
  END IF;
  RETURN NULL;
END
$_$;


--
-- Name: orgtree_work_index_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_work_index_row() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
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
$_$;


--
-- Name: orgtree_work_list_dirty(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_work_list_dirty() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE s text:=TG_TABLE_SCHEMA; old_id text; new_id text; oj jsonb; nj jsonb;
BEGIN
  IF TG_TABLE_NAME='work_index' THEN
    IF TG_OP<>'INSERT' THEN old_id:=OLD.slug; END IF;
    IF TG_OP<>'DELETE' THEN new_id:=NEW.slug; END IF;
  ELSIF TG_TABLE_NAME='log_d' THEN
    IF TG_OP<>'INSERT' AND OLD.sect='work_scope_log' THEN old_id:=OLD.owner; END IF;
    IF TG_OP<>'DELETE' AND NEW.sect='work_scope_log' THEN new_id:=NEW.owner; END IF;
    IF old_id IS NULL AND new_id IS NULL THEN RETURN NULL; END IF;
  ELSIF TG_TABLE_NAME='nodes' THEN
    IF TG_OP='UPDATE' AND OLD.id=NEW.id THEN
      oj:=OLD.val::jsonb;
      nj:=NEW.val::jsonb;
      IF jsonb_build_array(oj->'state',oj->'generation',oj->'seat_id',oj->'parent')=
         jsonb_build_array(nj->'state',nj->'generation',nj->'seat_id',nj->'parent') THEN
        RETURN NULL;
      END IF;
    END IF;
  ELSE
    IF TG_OP='UPDATE' AND OLD.key=NEW.key AND OLD.val=NEW.val THEN RETURN NULL; END IF;
    IF TG_OP<>'INSERT' THEN old_id:=OLD.key; END IF;
    IF TG_OP<>'DELETE' THEN new_id:=NEW.key; END IF;
    IF coalesce(old_id,'') NOT IN ('asks','nodes','work_scope_log','work_identity','release') AND
       coalesce(new_id,'') NOT IN ('asks','nodes','work_scope_log','work_identity','release') THEN RETURN NULL; END IF;
  END IF;
  -- Serialize with access refresh BEFORE dirty selection, including scope-only
  -- writes and identity changes that do not change access itself.
  EXECUTE format('SELECT singleton FROM %I.work_read_state WHERE singleton FOR UPDATE',s);
  EXECUTE format('UPDATE %I.work_list_state SET revision=revision+1 WHERE singleton',s);
  IF TG_TABLE_NAME IN ('work_index','log_d') THEN
    EXECUTE format('INSERT INTO %I.work_list_dirty SELECT DISTINCT x FROM unnest(ARRAY[$1,$2]) x '
      'WHERE x IS NOT NULL ON CONFLICT DO NOTHING',s) USING old_id,new_id;
  ELSIF TG_TABLE_NAME='doc' AND
    (old_id IN ('nodes','work_scope_log') OR new_id IN ('nodes','work_scope_log')) THEN
    EXECUTE format('UPDATE %I.work_list_state SET ready=false WHERE singleton',s);
  END IF;
  RETURN NULL;
END
$_$;


--
-- Name: orgtree_work_summary(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_work_summary(body text) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT public.orgtree_work_summary_before_query(body) || jsonb_build_object('_query',
    jsonb_build_object('format','orgtree.work-query/v1',
      'legacy_identity',body::jsonb ? 'id',
      'order_supported',
        coalesce(jsonb_typeof(body::jsonb->'docket_at'),'null') IN ('null','string') AND
        coalesce(jsonb_typeof(body::jsonb->'updated_at'),'null') IN ('null','string')));
$$;


--
-- Name: orgtree_work_summary_before_query(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgtree_work_summary_before_query(body text) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
  FROM json_each(body::json)
  WHERE key = ANY(ARRAY[
    'slug','rev','kind','title','objective','status','owner','reviewer','created_by',
    'at','updated_at','done_so_far','working_on_next','docket_at','last_updater',
    'manual_attention','next_action','objective_notice','post_completion','status_at',
    'superseded_by','parent','legacy_status','blocked_reason','waiting_reason',
    'dropped_reason','participants','archived_at','dependencies','scope_archive_summary',
    'notification_attention_active']);
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: doc; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.doc (
    key text NOT NULL,
    val text NOT NULL
);


--
-- Name: foreground_asks; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.foreground_asks (
    sect text NOT NULL,
    ord bigint NOT NULL,
    node text NOT NULL,
    status text NOT NULL,
    stamp text NOT NULL,
    val text NOT NULL
);


--
-- Name: foreground_blobs; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.foreground_blobs (
    key text NOT NULL,
    val jsonb NOT NULL
);


--
-- Name: foreground_counts; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.foreground_counts (
    source smallint NOT NULL,
    sect text NOT NULL,
    owner text NOT NULL,
    total bigint NOT NULL
);


--
-- Name: foreground_documents; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.foreground_documents (
    source smallint NOT NULL,
    seq bigint NOT NULL,
    node text NOT NULL,
    meta jsonb NOT NULL
);


--
-- Name: foreground_meta; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.foreground_meta (
    singleton integer NOT NULL,
    node_revision bigint NOT NULL,
    catalog_revision bigint NOT NULL,
    node_count bigint NOT NULL,
    view_revision bigint DEFAULT 0 NOT NULL,
    retired_axis_count bigint NOT NULL,
    cost numeric NOT NULL,
    cost_unknown bigint NOT NULL,
    CONSTRAINT foreground_meta_singleton_check CHECK ((singleton = 1))
);


--
-- Name: foreground_parents; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.foreground_parents (
    parent text NOT NULL,
    retired_children bigint NOT NULL
);


--
-- Name: log_d; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.log_d (
    seq bigint NOT NULL,
    sect text NOT NULL,
    owner text NOT NULL,
    at text,
    val text NOT NULL
);


--
-- Name: log_d_seq_seq; Type: SEQUENCE; Schema: org_1; Owner: -
--

ALTER TABLE org_1.log_d ALTER COLUMN seq ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME org_1.log_d_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: log_l; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.log_l (
    seq bigint NOT NULL,
    sect text NOT NULL,
    at text,
    val text NOT NULL
);


--
-- Name: log_l_seq_seq; Type: SEQUENCE; Schema: org_1; Owner: -
--

ALTER TABLE org_1.log_l ALTER COLUMN seq ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME org_1.log_l_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: mail_archive_bounds; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.mail_archive_bounds (
    owner text NOT NULL,
    nrows bigint NOT NULL,
    unknown_rows bigint NOT NULL,
    assigned_max numeric NOT NULL,
    version bigint NOT NULL,
    format integer NOT NULL,
    CONSTRAINT mail_archive_bounds_assigned_max_check CHECK ((assigned_max >= (0)::numeric)),
    CONSTRAINT mail_archive_bounds_check CHECK (((unknown_rows >= 0) AND (unknown_rows <= nrows))),
    CONSTRAINT mail_archive_bounds_nrows_check CHECK ((nrows >= 0))
);


--
-- Name: mail_sent; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.mail_sent (
    seq bigint NOT NULL,
    owner text NOT NULL,
    sender text,
    sent_at text NOT NULL,
    owner_pos bigint NOT NULL
);


--
-- Name: meta; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.meta (
    key text NOT NULL,
    val text NOT NULL
);


--
-- Name: node_index; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.node_index (
    id text NOT NULL,
    ord integer NOT NULL,
    meta jsonb NOT NULL,
    lineage_count bigint DEFAULT 0 NOT NULL,
    consult_id text
);


--
-- Name: node_tree_val; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.node_tree_val (
    id text NOT NULL,
    val text NOT NULL
);


--
-- Name: nodes; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.nodes (
    id text NOT NULL,
    ord integer NOT NULL,
    val text NOT NULL
);


--
-- Name: receipt_carriers; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.receipt_carriers (
    owner text NOT NULL,
    carrier text NOT NULL,
    token text NOT NULL
);


--
-- Name: receipt_format; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.receipt_format (
    singleton boolean DEFAULT true NOT NULL,
    format integer NOT NULL,
    present boolean NOT NULL,
    conversion_sha256 text NOT NULL,
    converted_owners bigint NOT NULL,
    converted_receipts bigint NOT NULL,
    converted_carriers bigint NOT NULL,
    CONSTRAINT receipt_format_format_check CHECK ((format = 1)),
    CONSTRAINT receipt_format_singleton_check CHECK (singleton)
);


--
-- Name: receipt_owner_versions; Type: SEQUENCE; Schema: org_1; Owner: -
--

CREATE SEQUENCE org_1.receipt_owner_versions
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: receipt_owners; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.receipt_owners (
    owner text NOT NULL,
    ord bigint NOT NULL,
    nrows bigint DEFAULT 0 NOT NULL,
    next_ord bigint DEFAULT 0 NOT NULL,
    version bigint DEFAULT nextval('org_1.receipt_owner_versions'::regclass) NOT NULL,
    CONSTRAINT receipt_owners_next_ord_check CHECK ((next_ord >= 0)),
    CONSTRAINT receipt_owners_nrows_check CHECK ((nrows >= 0))
);


--
-- Name: receipt_owners_ord_seq; Type: SEQUENCE; Schema: org_1; Owner: -
--

ALTER TABLE org_1.receipt_owners ALTER COLUMN ord ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME org_1.receipt_owners_ord_seq
    START WITH 0
    INCREMENT BY 1
    MINVALUE 0
    NO MAXVALUE
    CACHE 1
);


--
-- Name: receipts; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.receipts (
    owner text NOT NULL,
    token text NOT NULL,
    ord bigint NOT NULL,
    val text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT receipts_ord_check CHECK ((ord >= 0))
);


--
-- Name: work_index; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.work_index (
    location text NOT NULL,
    source_key text NOT NULL,
    slug text NOT NULL,
    summary jsonb NOT NULL,
    body_sha256 bytea NOT NULL,
    CONSTRAINT work_index_location_check CHECK ((location = ANY (ARRAY['active'::text, 'archive'::text])))
);


--
-- Name: work_index_state; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.work_index_state (
    singleton boolean DEFAULT true NOT NULL,
    format text DEFAULT 'orgtree.work-index/v1'::text NOT NULL,
    active_rows bigint DEFAULT 0 NOT NULL,
    archive_rows bigint DEFAULT 0 NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    valid boolean DEFAULT false NOT NULL,
    CONSTRAINT work_index_state_active_rows_check CHECK ((active_rows >= 0)),
    CONSTRAINT work_index_state_archive_rows_check CHECK ((archive_rows >= 0)),
    CONSTRAINT work_index_state_singleton_check CHECK (singleton)
);


--
-- Name: work_list_dirty; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.work_list_dirty (
    slug text NOT NULL
);


--
-- Name: work_list_state; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.work_list_state (
    singleton boolean NOT NULL,
    format text DEFAULT 'orgtree.work-list/v1'::text NOT NULL,
    initialized boolean DEFAULT false NOT NULL,
    ready boolean DEFAULT false NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT work_list_state_singleton_check CHECK (singleton)
);


--
-- Name: work_list_summary; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.work_list_summary (
    slug text NOT NULL,
    body_sha256 bytea NOT NULL,
    payload jsonb NOT NULL
);


--
-- Name: work_read_access; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.work_read_access (
    slug text NOT NULL,
    viewer text NOT NULL
);


--
-- Name: work_read_dependency; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.work_read_dependency (
    slug text NOT NULL,
    node_id text NOT NULL
);


--
-- Name: work_read_dirty; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.work_read_dirty (
    slug text NOT NULL
);


--
-- Name: work_read_policy; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.work_read_policy (
    slug text NOT NULL,
    location text NOT NULL,
    deadline double precision,
    manual boolean NOT NULL
);


--
-- Name: work_read_questions; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.work_read_questions (
    slug text NOT NULL,
    questions jsonb NOT NULL
);


--
-- Name: work_read_state; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.work_read_state (
    singleton boolean NOT NULL,
    format text DEFAULT 'orgtree.work-access/v1'::text NOT NULL,
    initialized boolean DEFAULT false NOT NULL,
    ready boolean DEFAULT false NOT NULL,
    questions_dirty boolean DEFAULT true NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT work_read_state_singleton_check CHECK (singleton)
);


--
-- Name: work_read_totals; Type: TABLE; Schema: org_1; Owner: -
--

CREATE TABLE org_1.work_read_totals (
    viewer text NOT NULL,
    total bigint NOT NULL,
    CONSTRAINT work_read_totals_total_check CHECK ((total >= 0))
);


--
-- Name: doc; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.doc (
    key text NOT NULL,
    val text NOT NULL
);


--
-- Name: foreground_asks; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.foreground_asks (
    sect text NOT NULL,
    ord bigint NOT NULL,
    node text NOT NULL,
    status text NOT NULL,
    stamp text NOT NULL,
    val text NOT NULL
);


--
-- Name: foreground_blobs; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.foreground_blobs (
    key text NOT NULL,
    val jsonb NOT NULL
);


--
-- Name: foreground_counts; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.foreground_counts (
    source smallint NOT NULL,
    sect text NOT NULL,
    owner text NOT NULL,
    total bigint NOT NULL
);


--
-- Name: foreground_documents; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.foreground_documents (
    source smallint NOT NULL,
    seq bigint NOT NULL,
    node text NOT NULL,
    meta jsonb NOT NULL
);


--
-- Name: foreground_meta; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.foreground_meta (
    singleton integer NOT NULL,
    node_revision bigint NOT NULL,
    catalog_revision bigint NOT NULL,
    node_count bigint NOT NULL,
    view_revision bigint DEFAULT 0 NOT NULL,
    retired_axis_count bigint NOT NULL,
    cost numeric NOT NULL,
    cost_unknown bigint NOT NULL,
    CONSTRAINT foreground_meta_singleton_check CHECK ((singleton = 1))
);


--
-- Name: foreground_parents; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.foreground_parents (
    parent text NOT NULL,
    retired_children bigint NOT NULL
);


--
-- Name: log_d; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.log_d (
    seq bigint NOT NULL,
    sect text NOT NULL,
    owner text NOT NULL,
    at text,
    val text NOT NULL
);


--
-- Name: log_d_seq_seq; Type: SEQUENCE; Schema: org_2; Owner: -
--

ALTER TABLE org_2.log_d ALTER COLUMN seq ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME org_2.log_d_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: log_l; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.log_l (
    seq bigint NOT NULL,
    sect text NOT NULL,
    at text,
    val text NOT NULL
);


--
-- Name: log_l_seq_seq; Type: SEQUENCE; Schema: org_2; Owner: -
--

ALTER TABLE org_2.log_l ALTER COLUMN seq ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME org_2.log_l_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: mail_archive_bounds; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.mail_archive_bounds (
    owner text NOT NULL,
    nrows bigint NOT NULL,
    unknown_rows bigint NOT NULL,
    assigned_max numeric NOT NULL,
    version bigint NOT NULL,
    format integer NOT NULL,
    CONSTRAINT mail_archive_bounds_assigned_max_check CHECK ((assigned_max >= (0)::numeric)),
    CONSTRAINT mail_archive_bounds_check CHECK (((unknown_rows >= 0) AND (unknown_rows <= nrows))),
    CONSTRAINT mail_archive_bounds_nrows_check CHECK ((nrows >= 0))
);


--
-- Name: mail_sent; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.mail_sent (
    seq bigint NOT NULL,
    owner text NOT NULL,
    sender text,
    sent_at text NOT NULL,
    owner_pos bigint NOT NULL
);


--
-- Name: meta; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.meta (
    key text NOT NULL,
    val text NOT NULL
);


--
-- Name: node_index; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.node_index (
    id text NOT NULL,
    ord integer NOT NULL,
    meta jsonb NOT NULL,
    lineage_count bigint DEFAULT 0 NOT NULL,
    consult_id text
);


--
-- Name: node_tree_val; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.node_tree_val (
    id text NOT NULL,
    val text NOT NULL
);


--
-- Name: nodes; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.nodes (
    id text NOT NULL,
    ord integer NOT NULL,
    val text NOT NULL
);


--
-- Name: receipt_carriers; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.receipt_carriers (
    owner text NOT NULL,
    carrier text NOT NULL,
    token text NOT NULL
);


--
-- Name: receipt_format; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.receipt_format (
    singleton boolean DEFAULT true NOT NULL,
    format integer NOT NULL,
    present boolean NOT NULL,
    conversion_sha256 text NOT NULL,
    converted_owners bigint NOT NULL,
    converted_receipts bigint NOT NULL,
    converted_carriers bigint NOT NULL,
    CONSTRAINT receipt_format_format_check CHECK ((format = 1)),
    CONSTRAINT receipt_format_singleton_check CHECK (singleton)
);


--
-- Name: receipt_owner_versions; Type: SEQUENCE; Schema: org_2; Owner: -
--

CREATE SEQUENCE org_2.receipt_owner_versions
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: receipt_owners; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.receipt_owners (
    owner text NOT NULL,
    ord bigint NOT NULL,
    nrows bigint DEFAULT 0 NOT NULL,
    next_ord bigint DEFAULT 0 NOT NULL,
    version bigint DEFAULT nextval('org_2.receipt_owner_versions'::regclass) NOT NULL,
    CONSTRAINT receipt_owners_next_ord_check CHECK ((next_ord >= 0)),
    CONSTRAINT receipt_owners_nrows_check CHECK ((nrows >= 0))
);


--
-- Name: receipt_owners_ord_seq; Type: SEQUENCE; Schema: org_2; Owner: -
--

ALTER TABLE org_2.receipt_owners ALTER COLUMN ord ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME org_2.receipt_owners_ord_seq
    START WITH 0
    INCREMENT BY 1
    MINVALUE 0
    NO MAXVALUE
    CACHE 1
);


--
-- Name: receipts; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.receipts (
    owner text NOT NULL,
    token text NOT NULL,
    ord bigint NOT NULL,
    val text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT receipts_ord_check CHECK ((ord >= 0))
);


--
-- Name: work_index; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.work_index (
    location text NOT NULL,
    source_key text NOT NULL,
    slug text NOT NULL,
    summary jsonb NOT NULL,
    body_sha256 bytea NOT NULL,
    CONSTRAINT work_index_location_check CHECK ((location = ANY (ARRAY['active'::text, 'archive'::text])))
);


--
-- Name: work_index_state; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.work_index_state (
    singleton boolean DEFAULT true NOT NULL,
    format text DEFAULT 'orgtree.work-index/v1'::text NOT NULL,
    active_rows bigint DEFAULT 0 NOT NULL,
    archive_rows bigint DEFAULT 0 NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    valid boolean DEFAULT false NOT NULL,
    CONSTRAINT work_index_state_active_rows_check CHECK ((active_rows >= 0)),
    CONSTRAINT work_index_state_archive_rows_check CHECK ((archive_rows >= 0)),
    CONSTRAINT work_index_state_singleton_check CHECK (singleton)
);


--
-- Name: work_list_dirty; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.work_list_dirty (
    slug text NOT NULL
);


--
-- Name: work_list_state; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.work_list_state (
    singleton boolean NOT NULL,
    format text DEFAULT 'orgtree.work-list/v1'::text NOT NULL,
    initialized boolean DEFAULT false NOT NULL,
    ready boolean DEFAULT false NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT work_list_state_singleton_check CHECK (singleton)
);


--
-- Name: work_list_summary; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.work_list_summary (
    slug text NOT NULL,
    body_sha256 bytea NOT NULL,
    payload jsonb NOT NULL
);


--
-- Name: work_read_access; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.work_read_access (
    slug text NOT NULL,
    viewer text NOT NULL
);


--
-- Name: work_read_dependency; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.work_read_dependency (
    slug text NOT NULL,
    node_id text NOT NULL
);


--
-- Name: work_read_dirty; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.work_read_dirty (
    slug text NOT NULL
);


--
-- Name: work_read_policy; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.work_read_policy (
    slug text NOT NULL,
    location text NOT NULL,
    deadline double precision,
    manual boolean NOT NULL
);


--
-- Name: work_read_questions; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.work_read_questions (
    slug text NOT NULL,
    questions jsonb NOT NULL
);


--
-- Name: work_read_state; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.work_read_state (
    singleton boolean NOT NULL,
    format text DEFAULT 'orgtree.work-access/v1'::text NOT NULL,
    initialized boolean DEFAULT false NOT NULL,
    ready boolean DEFAULT false NOT NULL,
    questions_dirty boolean DEFAULT true NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT work_read_state_singleton_check CHECK (singleton)
);


--
-- Name: work_read_totals; Type: TABLE; Schema: org_2; Owner: -
--

CREATE TABLE org_2.work_read_totals (
    viewer text NOT NULL,
    total bigint NOT NULL,
    CONSTRAINT work_read_totals_total_check CHECK ((total >= 0))
);


--
-- Name: org_statistics_ready; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_statistics_ready (
    org_id bigint NOT NULL,
    schema_version text NOT NULL,
    analyzed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: orgs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orgs (
    org_id bigint NOT NULL,
    slug text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    work_revision bigint DEFAULT 0 NOT NULL
);


--
-- Name: orgs_org_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.orgs ALTER COLUMN org_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.orgs_org_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receipts (
    org_id bigint NOT NULL,
    op_key text NOT NULL,
    fingerprint text,
    result text,
    at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    name text NOT NULL,
    sha256 text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Data for Name: doc; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.doc (key, val) FROM stdin;
version	3
slug	"alpha"
name	"alpha"
created	"2026-01-01T00:00:00.000Z"
tiers	{"opus":4,"fable":10,"sonnet":2,"haiku":1,"sol":2,"terra":2,"gpt-reserve":0.2,"luna":0.1,"astra":10,"flash":1,"pro":2,"argon":2}
models	{"opus":"claude-opus-4-6","fable":"claude-fable-5-1","sonnet":"claude-sonnet-5-5","haiku":"claude-haiku-4-5","sol":"gpt-6.1-sol","terra":"gpt-5.6-terra","gpt-reserve":"gpt-reserve","luna":"gpt-6-luna","astra":"gpt-6-astra","flash":"gemini-3.8-flash","pro":"gemini-3.1-pro","argon":"gemini-4-argon"}
workspace	"fixture-workspace"
dirs	[]
permission_mode	"acceptEdits"
default_tools	{"bash":true,"web":true,"edit":true,"subagents":true,"mcp":["*"]}
default_visibility	"full"
max_top_grant	1000
default_top_grant	50
credit_requests	[{"id":"credit1","node":"lead","old":4,"new":5,"at":"2026-01-01T00:00:00.000Z","status":"resolved"}]
compact_at	0.8
fable_limit_policy	"halt"
fable_filter_policy	"halt"
fable_filter_model	"opus"
external_inbox_multi_holder	false
org_inbox_multi_holder	false
audiences	[{"grantee":"lead","grantor":"user","granted_at":"2026-01-01T00:00:00.000Z"}]
audience_requests	[{"id":"audience1","node":"lead","target":"user","at":"2026-01-01T00:00:00.000Z"}]
cascade_hire	true
cascade_alloc	true
kiosk	null
_migrations	{"mail_log_ids":{"at":"2026-10-02T23:58:57.096Z","repaired":0},"steer_attempt_views":{"at":"2026-10-02T23:58:57.096Z","stripped":0},"extern_multi_holder_v1":{"at":"2026-10-02T23:58:57.096Z","mode":"inspect","holders":[],"multi_holder":false},"principal_seat_ids":{"at":"2026-10-02T23:58:57.096Z","minted":0,"shared":0}}
whole_grants_v1	true
_actors_typed	true
mail	{}
maillead	[{"id":"m1","from":"user","body":"Synthetic mail","at":"2026-01-01T00:00:00.000Z"}]
notices	{}
noticeslead	[{"at":"2026-01-01T00:00:00.000Z","text":"Synthetic notice"}]
delivering	{}
deliveringlead	[{"tok":"delivery1","at":"2026-01-01T00:00:00.000Z","mail":[],"notices":[]}]
mail_transitions	{"lead":{"transition1":{"operation":"deliver","outcome":"ok"}}}
manual_attempts	{"lead":{"manual1":{"at":"2026-01-01T00:00:00.000Z","mail_ids":["m1"]}}}
asks	[{"id":"ask1","node":"lead","kind":"ask","question":"Synthetic?","at":"2026-01-01T00:00:00.000Z","status":"answered","options":[],"answer":{"text":"Yes"}}]
scope_requests	[{"id":"scope1","node":"lead","items":[],"at":"2026-01-01T00:00:00.000Z","status":"resolved"}]
watchdogs	[{"id":"watch1","owner":"lead","name":"Synthetic","kind":"file","target":"synthetic.log","state":"paused","at":"2026-01-01T00:00:00.000Z","interval_s":60}]
watchdog_tombs	[{"id":"watch0","owner":"lead","name":"Old","kind":"file","target":"old.log","at":"2026-01-01T00:00:00.000Z","spent_at":"2026-01-01T00:00:00.000Z"}]
work_items	{"format":"orgtree.work-items/v1","ids":["synthetic-task","second-task"]}
work_itemssynthetic-task	{"slug":"synthetic-task","title":"Synthetic task","status":"open","owner":{"node":"lead","generation":0,"born":"fixture-lead"},"at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z","acceptance":[],"history":[],"notification_attention_epoch":1,"notification_attention_active":false}
work_itemssecond-task	{"slug":"second-task","title":"Second synthetic task","status":"open","at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z","notification_attention_epoch":1,"notification_attention_active":false}
user_inbox	[{"id":"user1","from":"lead","body":"Body","at":"2026-01-01T00:00:00.000Z"}]
orphan_keys	{}
account_fallback_default	null
api_cost_usd	null
default_account	null
desktop_import	null
reply_incarnation	null
work_deleted_names	["deleted-task"]
api_fallback	null
api_fallback_since	null
api_fallback_until	null
api_key	null
auto_cheap_compact	null
auto_resume	null
auto_resume_compact	null
auto_resume_last	null
cred_warned_at	null
default_effort	null
deleted_cost_usd	null
deleted_cost_usd_unknown	null
fable_api_fallback	null
fable_lock	null
headless	null
killswitch	null
mail_drain_version	null
max_children	null
max_depth	null
net_autoconnect	null
net_hubs	null
net_identity	null
net_spool	null
net_state	null
op_receipts_meta	null
org_inbox_read	null
reservations	null
tool_result_receipts	null
work_identity	null
\.


--
-- Data for Name: foreground_asks; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.foreground_asks (sect, ord, node, status, stamp, val) FROM stdin;
credit_requests	1	lead	resolved	2026-01-01T00:00:00.000Z	{"at": "2026-01-01T00:00:00.000Z", "id": "credit1", "new": 5, "old": 4, "node": "lead", "status": "resolved"}
asks	1	lead	answered	2026-01-01T00:00:00.000Z	{"at": "2026-01-01T00:00:00.000Z", "id": "ask1", "kind": "ask", "node": "lead", "answer": {"text": "Yes"}, "status": "answered", "options": [], "question": "Synthetic?"}
scope_requests	1	lead	resolved	2026-01-01T00:00:00.000Z	{"at": "2026-01-01T00:00:00.000Z", "id": "scope1", "node": "lead", "items": [], "status": "resolved"}
\.


--
-- Data for Name: foreground_blobs; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.foreground_blobs (key, val) FROM stdin;
\.


--
-- Data for Name: foreground_counts; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.foreground_counts (source, sect, owner, total) FROM stdin;
0	org_inbox		1
0	documents	lead	1
\.


--
-- Data for Name: foreground_documents; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.foreground_documents (source, seq, node, meta) FROM stdin;
0	3	lead	{"at": "2026-01-01T00:00:00.000Z", "id": "doc1", "title": "Synthetic", "format": "markdown"}
\.


--
-- Data for Name: foreground_meta; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.foreground_meta (singleton, node_revision, catalog_revision, node_count, view_revision, retired_axis_count, cost, cost_unknown) FROM stdin;
1	1	1	1	83	0	0	0
\.


--
-- Data for Name: foreground_parents; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.foreground_parents (parent, retired_children) FROM stdin;
\.


--
-- Data for Name: log_d; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.log_d (seq, sect, owner, at, val) FROM stdin;
1	turn_error_log	lead	2026-01-01T00:00:00.000Z	{"at":"2026-01-01T00:00:00.000Z","text":"Synthetic error"}
2	mail_log	lead	2026-01-01T00:00:00.000Z	{"id":"m0","from":"user","body":"Archived mail","at":"2026-01-01T00:00:00.000Z"}
3	steer_attempts	lead	\N	["attempt1",{"at":"2026-01-01T00:00:00.000Z","toks":["delivery1"]}]
4	turn_log	lead	2026-01-01T00:00:00.000Z	{"n":1,"at":"2026-01-01T00:00:00.000Z","cost":1.5,"ms":10}
5	steered_log	lead	2026-01-01T00:00:00.000Z	{"at":"2026-01-01T00:00:00.000Z","text":"Synthetic steer"}
\.


--
-- Data for Name: log_l; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.log_l (seq, sect, at, val) FROM stdin;
1	org_inbox	2026-01-01T00:00:00.000Z	{"id":"org1","dir":"in","peer":"synthetic","body":"Body","at":"2026-01-01T00:00:00.000Z"}
2	user_mail_log	2026-01-01T00:00:00.000Z	{"id":"log1","from":"lead","body":"Body","at":"2026-01-01T00:00:00.000Z"}
3	documents	2026-01-01T00:00:00.000Z	{"id":"doc1","node":"lead","title":"Synthetic","body":"Body","at":"2026-01-01T00:00:00.000Z"}
4	events	2026-01-01T00:00:00.000Z	{"at":"2026-01-01T00:00:00.000Z","op":"fixture","actor":"user"}
5	user_outbox	2026-01-01T00:00:00.000Z	{"id":"out1","to":"lead","body":"Body","at":"2026-01-01T00:00:00.000Z"}
6	lifecycle	2026-01-01T00:00:00.000Z	{"operation_id":"life1","kind":"fixture","state":"done","at":"2026-01-01T00:00:00.000Z"}
7	watchdog_history	2026-01-01T00:00:00.000Z	{"watchdog":"watch0","node":"lead","at":"2026-01-01T00:00:00.000Z","gist":"Synthetic"}
8	notice_log	2026-01-01T00:00:00.000Z	{"node":"lead","at":"2026-01-01T00:00:00.000Z","text":"Archived notice"}
9	work_items_archive	\N	{"slug":"old-task","title":"Old task","status":"done","archived_at":"2026-01-01T00:00:00.000Z","history":[]}
\.


--
-- Data for Name: mail_archive_bounds; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.mail_archive_bounds (owner, nrows, unknown_rows, assigned_max, version, format) FROM stdin;
lead	1	0	0	2	1
\.


--
-- Data for Name: mail_sent; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.mail_sent (seq, owner, sender, sent_at, owner_pos) FROM stdin;
2	lead	user	2026-01-01T00:00:00.000Z	2
\.


--
-- Data for Name: meta; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.meta (key, val) FROM stdin;
owners:turn_error_log	["lead"]
owners:mail_log	["lead"]
owners:steer_attempts	["lead"]
owners:work_scope_log	["lead"]
owners:turn_log	["lead"]
owners:steered_log	["lead"]
key_order	["version","slug","name","created","tiers","models","workspace","dirs","permission_mode","default_tools","default_visibility","max_top_grant","default_top_grant","credit_requests","compact_at","fable_limit_policy","fable_filter_policy","fable_filter_model","nodes","external_inbox_multi_holder","org_inbox_multi_holder","audiences","audience_requests","events","cascade_hire","cascade_alloc","kiosk","_migrations","whole_grants_v1","_actors_typed","mail","mail_log","notices","steered_log","delivering","turn_error_log","turn_log","mail_transitions","steer_attempts","manual_attempts","op_receipts","documents","asks","scope_requests","watchdogs","watchdog_tombs","work_items","work_items_archive","lifecycle","notice_log","watchdog_history","org_inbox","user_inbox","user_outbox","user_mail_log","orphan_keys","account_fallback_default","api_cost_usd","default_account","desktop_import","reply_incarnation","work_deleted_names","work_scope_log","api_fallback","api_fallback_since","api_fallback_until","api_key","auto_cheap_compact","auto_resume","auto_resume_compact","auto_resume_last","cred_warned_at","default_effort","deleted_cost_usd","deleted_cost_usd_unknown","fable_api_fallback","fable_lock","headless","killswitch","mail_drain_version","max_children","max_depth","net_autoconnect","net_hubs","net_identity","net_spool","net_state","op_receipts_meta","org_inbox_read","reservations","tool_result_receipts","work_identity"]
schema_version	1
\.


--
-- Data for Name: node_index; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.node_index (id, ord, meta, lineage_count, consult_id) FROM stdin;
lead	0	{"cost": 0, "grant": 4, "model": "claude-opus-4-6", "order": 0.0, "state": "live", "title": "Synthetic leader", "parent": "", "created": "2026-01-01T00:00:00.000Z", "successor": "", "generation": 0, "session_id": "fixture-session", "predecessor": "", "bearer_state": null, "cost_unknown": false, "reply_incarnation": null, "transcript_incarnation": null}	0	\N
\.


--
-- Data for Name: node_tree_val; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.node_tree_val (id, val) FROM stdin;
\.


--
-- Data for Name: nodes; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.nodes (id, ord, val) FROM stdin;
lead	0	{"id":"lead","name":"lead","parent":null,"state":"live","model":"claude-opus-4-6","tier":"opus","grant":4,"generation":0,"born":"fixture-lead","seat_id":"fixture-seat","session_id":"fixture-session","created":"2026-01-01T00:00:00.000Z","title":"Synthetic leader","charter":"Synthetic","scope":{"permission_mode":"acceptEdits","add_dirs":[],"tools":{"bash":false,"web":true,"edit":false,"subagents":true,"mcp":[]},"org_visibility":"full"},"ui_order":0.0}
\.


--
-- Data for Name: receipt_carriers; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.receipt_carriers (owner, carrier, token) FROM stdin;
\.


--
-- Data for Name: receipt_format; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.receipt_format (singleton, format, present, conversion_sha256, converted_owners, converted_receipts, converted_carriers) FROM stdin;
\.


--
-- Data for Name: receipt_owners; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.receipt_owners (owner, ord, nrows, next_ord, version) FROM stdin;
\.


--
-- Data for Name: receipts; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.receipts (owner, token, ord, val, version) FROM stdin;
\.


--
-- Data for Name: work_index; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.work_index (location, source_key, slug, summary, body_sha256) FROM stdin;
active	work_itemssynthetic-task	synthetic-task	{"at": "2026-01-01T00:00:00.000Z", "slug": "synthetic-task", "owner": {"born": "fixture-lead", "node": "lead", "generation": 0}, "title": "Synthetic task", "_query": {"format": "orgtree.work-query/v1", "legacy_identity": false, "order_supported": true}, "status": "open", "updated_at": "2026-01-01T00:00:00.000Z", "notification_attention_active": false}	\\xeacdac2a325e79ccd103784ffaaa9a3194acbcdde47ca58dcca3abab71a63ca4
active	work_itemssecond-task	second-task	{"at": "2026-01-01T00:00:00.000Z", "slug": "second-task", "title": "Second synthetic task", "_query": {"format": "orgtree.work-query/v1", "legacy_identity": false, "order_supported": true}, "status": "open", "updated_at": "2026-01-01T00:00:00.000Z", "notification_attention_active": false}	\\x527897fb23d0a67d270e835b62ca6676057c3a238d1760259f9c16b2c2de977c
archive	9	old-task	{"slug": "old-task", "title": "Old task", "_query": {"format": "orgtree.work-query/v1", "legacy_identity": false, "order_supported": true}, "status": "done", "archived_at": "2026-01-01T00:00:00.000Z"}	\\xea4a741b133e7e702c299afdb40a87df48e413e046c3145fbacf2975ff0a2726
\.


--
-- Data for Name: work_index_state; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.work_index_state (singleton, format, active_rows, archive_rows, revision, valid) FROM stdin;
t	orgtree.work-index/v1	2	1	3	t
\.


--
-- Data for Name: work_list_dirty; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.work_list_dirty (slug) FROM stdin;
\.


--
-- Data for Name: work_list_state; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.work_list_state (singleton, format, initialized, ready, revision) FROM stdin;
t	orgtree.work-list/v1	t	t	6
\.


--
-- Data for Name: work_list_summary; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.work_list_summary (slug, body_sha256, payload) FROM stdin;
old-task	\\xea4a741b133e7e702c299afdb40a87df48e413e046c3145fbacf2975ff0a2726	{"slug": "old-task", "title": "Old task", "_query": {"format": "orgtree.work-query/v1", "legacy_identity": false, "order_supported": true}, "status": "done", "status_at": "", "archived_at": "2026-01-01T00:00:00.000Z", "objective_notice": null, "scope_archive_summary": {"count": 0, "last_at": null, "first_at": null, "last_seq": null, "first_seq": null}}
second-task	\\x527897fb23d0a67d270e835b62ca6676057c3a238d1760259f9c16b2c2de977c	{"at": "2026-01-01T00:00:00.000Z", "slug": "second-task", "title": "Second synthetic task", "_query": {"format": "orgtree.work-query/v1", "legacy_identity": false, "order_supported": true}, "status": "open", "status_at": "2026-01-01T00:00:00.000Z", "updated_at": "2026-01-01T00:00:00.000Z", "objective_notice": null, "scope_archive_summary": {"count": 0, "last_at": null, "first_at": null, "last_seq": null, "first_seq": null}, "notification_attention_active": false}
synthetic-task	\\xeacdac2a325e79ccd103784ffaaa9a3194acbcdde47ca58dcca3abab71a63ca4	{"at": "2026-01-01T00:00:00.000Z", "slug": "synthetic-task", "owner": {"born": "fixture-lead", "node": "lead", "generation": 0}, "title": "Synthetic task", "_query": {"format": "orgtree.work-query/v1", "legacy_identity": false, "order_supported": true}, "status": "open", "status_at": "2026-01-01T00:00:00.000Z", "updated_at": "2026-01-01T00:00:00.000Z", "objective_notice": null, "scope_archive_summary": {"count": 0, "last_at": null, "first_at": null, "last_seq": null, "first_seq": null}, "notification_attention_active": false}
\.


--
-- Data for Name: work_read_access; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.work_read_access (slug, viewer) FROM stdin;
old-task	@user
second-task	@user
synthetic-task	@user
synthetic-task	lead
\.


--
-- Data for Name: work_read_dependency; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.work_read_dependency (slug, node_id) FROM stdin;
synthetic-task	lead
\.


--
-- Data for Name: work_read_dirty; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.work_read_dirty (slug) FROM stdin;
\.


--
-- Data for Name: work_read_policy; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.work_read_policy (slug, location, deadline, manual) FROM stdin;
old-task	archive	\N	f
second-task	active	\N	f
synthetic-task	active	\N	f
\.


--
-- Data for Name: work_read_questions; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.work_read_questions (slug, questions) FROM stdin;
\.


--
-- Data for Name: work_read_state; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.work_read_state (singleton, format, initialized, ready, questions_dirty, revision) FROM stdin;
t	orgtree.work-access/v1	t	t	f	6
\.


--
-- Data for Name: work_read_totals; Type: TABLE DATA; Schema: org_1; Owner: -
--

COPY org_1.work_read_totals (viewer, total) FROM stdin;
@user	3
lead	1
\.


--
-- Data for Name: doc; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.doc (key, val) FROM stdin;
version	3
slug	"beta"
name	"beta"
created	"2026-01-01T00:00:00.000Z"
tiers	{"opus":4,"fable":10,"sonnet":2,"haiku":1,"sol":2,"terra":2,"gpt-reserve":0.2,"luna":0.1,"astra":10,"flash":1,"pro":2,"argon":2}
models	{"opus":"claude-opus-4-6","fable":"claude-fable-5-1","sonnet":"claude-sonnet-5-5","haiku":"claude-haiku-4-5","sol":"gpt-6.1-sol","terra":"gpt-5.6-terra","gpt-reserve":"gpt-reserve","luna":"gpt-6-luna","astra":"gpt-6-astra","flash":"gemini-3.8-flash","pro":"gemini-3.1-pro","argon":"gemini-4-argon"}
workspace	"fixture-workspace"
dirs	[]
permission_mode	"acceptEdits"
default_tools	{"bash":true,"web":true,"edit":true,"subagents":true,"mcp":["*"]}
default_visibility	"full"
max_top_grant	1000
default_top_grant	50
credit_requests	[{"id":"credit1","node":"lead","old":4,"new":5,"at":"2026-01-01T00:00:00.000Z","status":"resolved"}]
compact_at	0.8
fable_limit_policy	"halt"
fable_filter_policy	"halt"
fable_filter_model	"opus"
external_inbox_multi_holder	false
org_inbox_multi_holder	false
audiences	[{"grantee":"lead","grantor":"user","granted_at":"2026-01-01T00:00:00.000Z"}]
audience_requests	[{"id":"audience1","node":"lead","target":"user","at":"2026-01-01T00:00:00.000Z"}]
cascade_hire	true
cascade_alloc	true
kiosk	null
_migrations	{"mail_log_ids":{"at":"2026-10-02T23:58:57.385Z","repaired":0},"steer_attempt_views":{"at":"2026-10-02T23:58:57.385Z","stripped":0},"extern_multi_holder_v1":{"at":"2026-10-02T23:58:57.385Z","mode":"inspect","holders":[],"multi_holder":false},"principal_seat_ids":{"at":"2026-10-02T23:58:57.385Z","minted":0,"shared":0}}
whole_grants_v1	true
_actors_typed	true
mail	{}
maillead	[{"id":"m1","from":"user","body":"Synthetic mail","at":"2026-01-01T00:00:00.000Z"}]
notices	{}
noticeslead	[{"at":"2026-01-01T00:00:00.000Z","text":"Synthetic notice"}]
delivering	{}
deliveringlead	[{"tok":"delivery1","at":"2026-01-01T00:00:00.000Z","mail":[],"notices":[]}]
mail_transitions	{"lead":{"transition1":{"operation":"deliver","outcome":"ok"}}}
manual_attempts	{"lead":{"manual1":{"at":"2026-01-01T00:00:00.000Z","mail_ids":["m1"]}}}
asks	[{"id":"ask1","node":"lead","kind":"ask","question":"Synthetic?","at":"2026-01-01T00:00:00.000Z","status":"answered","options":[],"answer":{"text":"Yes"}}]
scope_requests	[{"id":"scope1","node":"lead","items":[],"at":"2026-01-01T00:00:00.000Z","status":"resolved"}]
watchdogs	[{"id":"watch1","owner":"lead","name":"Synthetic","kind":"file","target":"synthetic.log","state":"paused","at":"2026-01-01T00:00:00.000Z","interval_s":60}]
watchdog_tombs	[{"id":"watch0","owner":"lead","name":"Old","kind":"file","target":"old.log","at":"2026-01-01T00:00:00.000Z","spent_at":"2026-01-01T00:00:00.000Z"}]
work_items	{"format":"orgtree.work-items/v1","ids":["synthetic-task","second-task"]}
work_itemssynthetic-task	{"slug":"synthetic-task","title":"Synthetic task","status":"open","owner":{"node":"lead","generation":0,"born":"fixture-lead"},"at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z","acceptance":[],"history":[],"notification_attention_epoch":1,"notification_attention_active":false}
work_itemssecond-task	{"slug":"second-task","title":"Second synthetic task","status":"open","at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z","notification_attention_epoch":1,"notification_attention_active":false}
user_inbox	[{"id":"user1","from":"lead","body":"Body","at":"2026-01-01T00:00:00.000Z"}]
orphan_keys	{}
account_fallback_default	null
api_cost_usd	null
default_account	null
desktop_import	null
reply_incarnation	null
work_deleted_names	["deleted-task"]
api_fallback	null
api_fallback_since	null
api_fallback_until	null
api_key	null
auto_cheap_compact	null
auto_resume	null
auto_resume_compact	null
auto_resume_last	null
cred_warned_at	null
default_effort	null
deleted_cost_usd	null
deleted_cost_usd_unknown	null
fable_api_fallback	null
fable_lock	null
headless	null
killswitch	null
mail_drain_version	null
max_children	null
max_depth	null
net_autoconnect	null
net_hubs	null
net_identity	null
net_spool	null
net_state	null
op_receipts_meta	null
org_inbox_read	null
reservations	null
tool_result_receipts	null
work_identity	null
\.


--
-- Data for Name: foreground_asks; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.foreground_asks (sect, ord, node, status, stamp, val) FROM stdin;
credit_requests	1	lead	resolved	2026-01-01T00:00:00.000Z	{"at": "2026-01-01T00:00:00.000Z", "id": "credit1", "new": 5, "old": 4, "node": "lead", "status": "resolved"}
asks	1	lead	answered	2026-01-01T00:00:00.000Z	{"at": "2026-01-01T00:00:00.000Z", "id": "ask1", "kind": "ask", "node": "lead", "answer": {"text": "Yes"}, "status": "answered", "options": [], "question": "Synthetic?"}
scope_requests	1	lead	resolved	2026-01-01T00:00:00.000Z	{"at": "2026-01-01T00:00:00.000Z", "id": "scope1", "node": "lead", "items": [], "status": "resolved"}
\.


--
-- Data for Name: foreground_blobs; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.foreground_blobs (key, val) FROM stdin;
\.


--
-- Data for Name: foreground_counts; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.foreground_counts (source, sect, owner, total) FROM stdin;
0	org_inbox		1
0	documents	lead	1
\.


--
-- Data for Name: foreground_documents; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.foreground_documents (source, seq, node, meta) FROM stdin;
0	3	lead	{"at": "2026-01-01T00:00:00.000Z", "id": "doc1", "title": "Synthetic", "format": "markdown"}
\.


--
-- Data for Name: foreground_meta; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.foreground_meta (singleton, node_revision, catalog_revision, node_count, view_revision, retired_axis_count, cost, cost_unknown) FROM stdin;
1	1	1	1	83	0	0	0
\.


--
-- Data for Name: foreground_parents; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.foreground_parents (parent, retired_children) FROM stdin;
\.


--
-- Data for Name: log_d; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.log_d (seq, sect, owner, at, val) FROM stdin;
1	turn_error_log	lead	2026-01-01T00:00:00.000Z	{"at":"2026-01-01T00:00:00.000Z","text":"Synthetic error"}
2	mail_log	lead	2026-01-01T00:00:00.000Z	{"id":"m0","from":"user","body":"Archived mail","at":"2026-01-01T00:00:00.000Z"}
3	steer_attempts	lead	\N	["attempt1",{"at":"2026-01-01T00:00:00.000Z","toks":["delivery1"]}]
4	turn_log	lead	2026-01-01T00:00:00.000Z	{"n":1,"at":"2026-01-01T00:00:00.000Z","cost":1.5,"ms":10}
5	steered_log	lead	2026-01-01T00:00:00.000Z	{"at":"2026-01-01T00:00:00.000Z","text":"Synthetic steer"}
\.


--
-- Data for Name: log_l; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.log_l (seq, sect, at, val) FROM stdin;
1	org_inbox	2026-01-01T00:00:00.000Z	{"id":"org1","dir":"in","peer":"synthetic","body":"Body","at":"2026-01-01T00:00:00.000Z"}
2	user_mail_log	2026-01-01T00:00:00.000Z	{"id":"log1","from":"lead","body":"Body","at":"2026-01-01T00:00:00.000Z"}
3	documents	2026-01-01T00:00:00.000Z	{"id":"doc1","node":"lead","title":"Synthetic","body":"Body","at":"2026-01-01T00:00:00.000Z"}
4	events	2026-01-01T00:00:00.000Z	{"at":"2026-01-01T00:00:00.000Z","op":"fixture","actor":"user"}
5	user_outbox	2026-01-01T00:00:00.000Z	{"id":"out1","to":"lead","body":"Body","at":"2026-01-01T00:00:00.000Z"}
6	lifecycle	2026-01-01T00:00:00.000Z	{"operation_id":"life1","kind":"fixture","state":"done","at":"2026-01-01T00:00:00.000Z"}
7	watchdog_history	2026-01-01T00:00:00.000Z	{"watchdog":"watch0","node":"lead","at":"2026-01-01T00:00:00.000Z","gist":"Synthetic"}
8	notice_log	2026-01-01T00:00:00.000Z	{"node":"lead","at":"2026-01-01T00:00:00.000Z","text":"Archived notice"}
9	work_items_archive	\N	{"slug":"old-task","title":"Old task","status":"done","archived_at":"2026-01-01T00:00:00.000Z","history":[]}
\.


--
-- Data for Name: mail_archive_bounds; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.mail_archive_bounds (owner, nrows, unknown_rows, assigned_max, version, format) FROM stdin;
lead	1	0	0	2	1
\.


--
-- Data for Name: mail_sent; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.mail_sent (seq, owner, sender, sent_at, owner_pos) FROM stdin;
2	lead	user	2026-01-01T00:00:00.000Z	2
\.


--
-- Data for Name: meta; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.meta (key, val) FROM stdin;
owners:turn_error_log	["lead"]
owners:mail_log	["lead"]
owners:steer_attempts	["lead"]
owners:work_scope_log	["lead"]
owners:turn_log	["lead"]
owners:steered_log	["lead"]
key_order	["version","slug","name","created","tiers","models","workspace","dirs","permission_mode","default_tools","default_visibility","max_top_grant","default_top_grant","credit_requests","compact_at","fable_limit_policy","fable_filter_policy","fable_filter_model","nodes","external_inbox_multi_holder","org_inbox_multi_holder","audiences","audience_requests","events","cascade_hire","cascade_alloc","kiosk","_migrations","whole_grants_v1","_actors_typed","mail","mail_log","notices","steered_log","delivering","turn_error_log","turn_log","mail_transitions","steer_attempts","manual_attempts","op_receipts","documents","asks","scope_requests","watchdogs","watchdog_tombs","work_items","work_items_archive","lifecycle","notice_log","watchdog_history","org_inbox","user_inbox","user_outbox","user_mail_log","orphan_keys","account_fallback_default","api_cost_usd","default_account","desktop_import","reply_incarnation","work_deleted_names","work_scope_log","api_fallback","api_fallback_since","api_fallback_until","api_key","auto_cheap_compact","auto_resume","auto_resume_compact","auto_resume_last","cred_warned_at","default_effort","deleted_cost_usd","deleted_cost_usd_unknown","fable_api_fallback","fable_lock","headless","killswitch","mail_drain_version","max_children","max_depth","net_autoconnect","net_hubs","net_identity","net_spool","net_state","op_receipts_meta","org_inbox_read","reservations","tool_result_receipts","work_identity"]
schema_version	1
\.


--
-- Data for Name: node_index; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.node_index (id, ord, meta, lineage_count, consult_id) FROM stdin;
lead	0	{"cost": 0, "grant": 4, "model": "claude-opus-4-6", "order": 0.0, "state": "live", "title": "Synthetic leader", "parent": "", "created": "2026-01-01T00:00:00.000Z", "successor": "", "generation": 0, "session_id": "fixture-session", "predecessor": "", "bearer_state": null, "cost_unknown": false, "reply_incarnation": null, "transcript_incarnation": null}	0	\N
\.


--
-- Data for Name: node_tree_val; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.node_tree_val (id, val) FROM stdin;
\.


--
-- Data for Name: nodes; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.nodes (id, ord, val) FROM stdin;
lead	0	{"id":"lead","name":"lead","parent":null,"state":"live","model":"claude-opus-4-6","tier":"opus","grant":4,"generation":0,"born":"fixture-lead","seat_id":"fixture-seat","session_id":"fixture-session","created":"2026-01-01T00:00:00.000Z","title":"Synthetic leader","charter":"Synthetic","scope":{"permission_mode":"acceptEdits","add_dirs":[],"tools":{"bash":false,"web":true,"edit":false,"subagents":true,"mcp":[]},"org_visibility":"full"},"ui_order":0.0}
\.


--
-- Data for Name: receipt_carriers; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.receipt_carriers (owner, carrier, token) FROM stdin;
\.


--
-- Data for Name: receipt_format; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.receipt_format (singleton, format, present, conversion_sha256, converted_owners, converted_receipts, converted_carriers) FROM stdin;
\.


--
-- Data for Name: receipt_owners; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.receipt_owners (owner, ord, nrows, next_ord, version) FROM stdin;
\.


--
-- Data for Name: receipts; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.receipts (owner, token, ord, val, version) FROM stdin;
\.


--
-- Data for Name: work_index; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.work_index (location, source_key, slug, summary, body_sha256) FROM stdin;
active	work_itemssynthetic-task	synthetic-task	{"at": "2026-01-01T00:00:00.000Z", "slug": "synthetic-task", "owner": {"born": "fixture-lead", "node": "lead", "generation": 0}, "title": "Synthetic task", "_query": {"format": "orgtree.work-query/v1", "legacy_identity": false, "order_supported": true}, "status": "open", "updated_at": "2026-01-01T00:00:00.000Z", "notification_attention_active": false}	\\xeacdac2a325e79ccd103784ffaaa9a3194acbcdde47ca58dcca3abab71a63ca4
active	work_itemssecond-task	second-task	{"at": "2026-01-01T00:00:00.000Z", "slug": "second-task", "title": "Second synthetic task", "_query": {"format": "orgtree.work-query/v1", "legacy_identity": false, "order_supported": true}, "status": "open", "updated_at": "2026-01-01T00:00:00.000Z", "notification_attention_active": false}	\\x527897fb23d0a67d270e835b62ca6676057c3a238d1760259f9c16b2c2de977c
archive	9	old-task	{"slug": "old-task", "title": "Old task", "_query": {"format": "orgtree.work-query/v1", "legacy_identity": false, "order_supported": true}, "status": "done", "archived_at": "2026-01-01T00:00:00.000Z"}	\\xea4a741b133e7e702c299afdb40a87df48e413e046c3145fbacf2975ff0a2726
\.


--
-- Data for Name: work_index_state; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.work_index_state (singleton, format, active_rows, archive_rows, revision, valid) FROM stdin;
t	orgtree.work-index/v1	2	1	3	t
\.


--
-- Data for Name: work_list_dirty; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.work_list_dirty (slug) FROM stdin;
\.


--
-- Data for Name: work_list_state; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.work_list_state (singleton, format, initialized, ready, revision) FROM stdin;
t	orgtree.work-list/v1	t	t	6
\.


--
-- Data for Name: work_list_summary; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.work_list_summary (slug, body_sha256, payload) FROM stdin;
old-task	\\xea4a741b133e7e702c299afdb40a87df48e413e046c3145fbacf2975ff0a2726	{"slug": "old-task", "title": "Old task", "_query": {"format": "orgtree.work-query/v1", "legacy_identity": false, "order_supported": true}, "status": "done", "status_at": "", "archived_at": "2026-01-01T00:00:00.000Z", "objective_notice": null, "scope_archive_summary": {"count": 0, "last_at": null, "first_at": null, "last_seq": null, "first_seq": null}}
second-task	\\x527897fb23d0a67d270e835b62ca6676057c3a238d1760259f9c16b2c2de977c	{"at": "2026-01-01T00:00:00.000Z", "slug": "second-task", "title": "Second synthetic task", "_query": {"format": "orgtree.work-query/v1", "legacy_identity": false, "order_supported": true}, "status": "open", "status_at": "2026-01-01T00:00:00.000Z", "updated_at": "2026-01-01T00:00:00.000Z", "objective_notice": null, "scope_archive_summary": {"count": 0, "last_at": null, "first_at": null, "last_seq": null, "first_seq": null}, "notification_attention_active": false}
synthetic-task	\\xeacdac2a325e79ccd103784ffaaa9a3194acbcdde47ca58dcca3abab71a63ca4	{"at": "2026-01-01T00:00:00.000Z", "slug": "synthetic-task", "owner": {"born": "fixture-lead", "node": "lead", "generation": 0}, "title": "Synthetic task", "_query": {"format": "orgtree.work-query/v1", "legacy_identity": false, "order_supported": true}, "status": "open", "status_at": "2026-01-01T00:00:00.000Z", "updated_at": "2026-01-01T00:00:00.000Z", "objective_notice": null, "scope_archive_summary": {"count": 0, "last_at": null, "first_at": null, "last_seq": null, "first_seq": null}, "notification_attention_active": false}
\.


--
-- Data for Name: work_read_access; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.work_read_access (slug, viewer) FROM stdin;
old-task	@user
second-task	@user
synthetic-task	@user
synthetic-task	lead
\.


--
-- Data for Name: work_read_dependency; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.work_read_dependency (slug, node_id) FROM stdin;
synthetic-task	lead
\.


--
-- Data for Name: work_read_dirty; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.work_read_dirty (slug) FROM stdin;
\.


--
-- Data for Name: work_read_policy; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.work_read_policy (slug, location, deadline, manual) FROM stdin;
old-task	archive	\N	f
second-task	active	\N	f
synthetic-task	active	\N	f
\.


--
-- Data for Name: work_read_questions; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.work_read_questions (slug, questions) FROM stdin;
\.


--
-- Data for Name: work_read_state; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.work_read_state (singleton, format, initialized, ready, questions_dirty, revision) FROM stdin;
t	orgtree.work-access/v1	t	t	f	6
\.


--
-- Data for Name: work_read_totals; Type: TABLE DATA; Schema: org_2; Owner: -
--

COPY org_2.work_read_totals (viewer, total) FROM stdin;
@user	3
lead	1
\.


--
-- Data for Name: org_statistics_ready; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.org_statistics_ready (org_id, schema_version, analyzed_at) FROM stdin;
\.


--
-- Data for Name: orgs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.orgs (org_id, slug, revision, created_at, deleted_at, work_revision) FROM stdin;
1	alpha	1	2026-10-03 02:58:57.115947+03	\N	1
2	beta	1	2026-10-03 02:58:57.386014+03	\N	1
\.


--
-- Data for Name: receipts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.receipts (org_id, op_key, fingerprint, result, at) FROM stdin;
\.


--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.schema_migrations (name, sha256, applied_at) FROM stdin;
0001_base.sql	887bccebdf1a53ba062d17acb091a106c267574ddd1a3c2d7e4c8e94e79b8b38	2026-10-03 02:58:56.98993+03
0002_runtime_grants.sql	2abf59da7b929a8b05a8ab20f9eb9be40b48b68f23657857abc8deb85372d30b	2026-10-03 02:58:56.999232+03
0003_work_item_rows.sql	e609ae457710e7f86dfa76ad476ab7cbe6742a273a860f3498882419347b92e4	2026-10-03 02:58:57.003503+03
0004_foreground_nodes.sql	6a547d65b075b6173b76f77586044e78595b38f4ea755c70953e21714d47cdf0	2026-10-03 02:58:57.015261+03
0005_mail_archive_bounds.sql	489ebe8120810b38ae573e7ecb91b7f44ed99d667417a311c040a4543e79123c	2026-10-03 02:58:57.025651+03
0006_work_index.sql	3adb7085389cd2b8db51ae2dd0ff58c1ef70be458ee5866e040de8703c277a8b	2026-10-03 02:58:57.034967+03
0007_mail_sent_index.sql	65b78160a855488f20167a000c8080d58e3fb58ff2506249a9edb9e4b4744d57	2026-10-03 02:58:57.037373+03
0008_work_access.sql	a3e89bbee4218b15ba1551d5675ea8ec16c9dc166072ba9d79f23beb4f4e89d8	2026-10-03 02:58:57.03913+03
0009_work_query.sql	ef0cede4372668fe442b0f1d1ccccae9e1287822feda4a770352dbf655ebbf68	2026-10-03 02:58:57.041041+03
0010_policy_candidates.sql	64f1427b634f099b6e641955de4d1a196a8e0b11d312da151625da658c91ab97	2026-10-03 02:58:57.042623+03
0011_initial_statistics.sql	71d7aeb436772e4efa0af523afbbbd5841ac75853226f2d253eb24de05ce89dc	2026-10-03 02:58:57.044083+03
0012_work_list.sql	e5171c98b1052b04b08a78a4565178edee913d8c20263b132433509a247e5ade	2026-10-03 02:58:57.047492+03
0013_custody_receipt_rows.sql	80840a75c1ef6dee12825fa9fd9730a7a73ceb0bba928f8432b73574ccd7a522	2026-10-03 02:58:57.054552+03
0014_summary_cost_exceptions.sql	78622e24d4a27e29b93d23fee16cde10fde56d14c9eb4a6ed392f435842d3366	2026-10-03 02:58:57.057105+03
0015_receipt_function_hardening.sql	e8ec848bdadee07ce63ae96022165c2cc1c801684a4b86f17b4c33bb47cf0c6c	2026-10-03 02:58:57.058719+03
0016_steered_log_tail.sql	238deef0e6cb77bd50f005aff3e7ebc3b4d6c4f9616213b6e6d967f95a5ec917	2026-10-03 02:58:57.05997+03
0017_foreground_tree_val.sql	855cbadfa7bdc6c36ebf8fc267f8ddf7dab22468a04855f70979b80522f284a4	2026-10-03 02:58:57.061307+03
0018_foreground_asks_resolved_recent.sql	fbe3c77dfb1cbfd943ab81ce26a6aa35afbfcdcf47a05e39676681a875f31d08	2026-10-03 02:58:57.062775+03
0019_present_evicted_index.sql	3b0ec7b21d52e428aa729fbd79ac2e4b6100e31ad0aefceb093cb84188085452	2026-10-03 02:58:57.064126+03
0020_work_list_parse_once.sql	21984e006af3595348cd5b5813095e8eca055d7002797beb808db7332d6b2e85	2026-10-03 02:58:57.071611+03
\.


--
-- Name: log_d_seq_seq; Type: SEQUENCE SET; Schema: org_1; Owner: -
--

SELECT pg_catalog.setval('org_1.log_d_seq_seq', 5, true);


--
-- Name: log_l_seq_seq; Type: SEQUENCE SET; Schema: org_1; Owner: -
--

SELECT pg_catalog.setval('org_1.log_l_seq_seq', 9, true);


--
-- Name: receipt_owner_versions; Type: SEQUENCE SET; Schema: org_1; Owner: -
--

SELECT pg_catalog.setval('org_1.receipt_owner_versions', 1, false);


--
-- Name: receipt_owners_ord_seq; Type: SEQUENCE SET; Schema: org_1; Owner: -
--

SELECT pg_catalog.setval('org_1.receipt_owners_ord_seq', 0, false);


--
-- Name: log_d_seq_seq; Type: SEQUENCE SET; Schema: org_2; Owner: -
--

SELECT pg_catalog.setval('org_2.log_d_seq_seq', 5, true);


--
-- Name: log_l_seq_seq; Type: SEQUENCE SET; Schema: org_2; Owner: -
--

SELECT pg_catalog.setval('org_2.log_l_seq_seq', 9, true);


--
-- Name: receipt_owner_versions; Type: SEQUENCE SET; Schema: org_2; Owner: -
--

SELECT pg_catalog.setval('org_2.receipt_owner_versions', 1, false);


--
-- Name: receipt_owners_ord_seq; Type: SEQUENCE SET; Schema: org_2; Owner: -
--

SELECT pg_catalog.setval('org_2.receipt_owners_ord_seq', 0, false);


--
-- Name: orgs_org_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.orgs_org_id_seq', 2, true);


--
-- Name: doc doc_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.doc
    ADD CONSTRAINT doc_pkey PRIMARY KEY (key);


--
-- Name: foreground_asks foreground_asks_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.foreground_asks
    ADD CONSTRAINT foreground_asks_pkey PRIMARY KEY (sect, ord);


--
-- Name: foreground_blobs foreground_blobs_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.foreground_blobs
    ADD CONSTRAINT foreground_blobs_pkey PRIMARY KEY (key);


--
-- Name: foreground_counts foreground_counts_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.foreground_counts
    ADD CONSTRAINT foreground_counts_pkey PRIMARY KEY (source, sect, owner);


--
-- Name: foreground_documents foreground_documents_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.foreground_documents
    ADD CONSTRAINT foreground_documents_pkey PRIMARY KEY (source, seq);


--
-- Name: foreground_meta foreground_meta_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.foreground_meta
    ADD CONSTRAINT foreground_meta_pkey PRIMARY KEY (singleton);


--
-- Name: foreground_parents foreground_parents_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.foreground_parents
    ADD CONSTRAINT foreground_parents_pkey PRIMARY KEY (parent);


--
-- Name: log_d log_d_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.log_d
    ADD CONSTRAINT log_d_pkey PRIMARY KEY (seq);


--
-- Name: log_l log_l_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.log_l
    ADD CONSTRAINT log_l_pkey PRIMARY KEY (seq);


--
-- Name: mail_archive_bounds mail_archive_bounds_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.mail_archive_bounds
    ADD CONSTRAINT mail_archive_bounds_pkey PRIMARY KEY (owner);


--
-- Name: mail_sent mail_sent_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.mail_sent
    ADD CONSTRAINT mail_sent_pkey PRIMARY KEY (seq);


--
-- Name: meta meta_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.meta
    ADD CONSTRAINT meta_pkey PRIMARY KEY (key);


--
-- Name: node_index node_index_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.node_index
    ADD CONSTRAINT node_index_pkey PRIMARY KEY (id);


--
-- Name: node_tree_val node_tree_val_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.node_tree_val
    ADD CONSTRAINT node_tree_val_pkey PRIMARY KEY (id);


--
-- Name: nodes nodes_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.nodes
    ADD CONSTRAINT nodes_pkey PRIMARY KEY (id);


--
-- Name: receipt_carriers receipt_carriers_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.receipt_carriers
    ADD CONSTRAINT receipt_carriers_pkey PRIMARY KEY (owner, carrier, token);


--
-- Name: receipt_format receipt_format_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.receipt_format
    ADD CONSTRAINT receipt_format_pkey PRIMARY KEY (singleton);


--
-- Name: receipt_owners receipt_owners_ord_key; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.receipt_owners
    ADD CONSTRAINT receipt_owners_ord_key UNIQUE (ord);


--
-- Name: receipt_owners receipt_owners_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.receipt_owners
    ADD CONSTRAINT receipt_owners_pkey PRIMARY KEY (owner);


--
-- Name: receipts receipts_owner_ord_key; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.receipts
    ADD CONSTRAINT receipts_owner_ord_key UNIQUE (owner, ord);


--
-- Name: receipts receipts_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.receipts
    ADD CONSTRAINT receipts_pkey PRIMARY KEY (owner, token);


--
-- Name: work_index work_index_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.work_index
    ADD CONSTRAINT work_index_pkey PRIMARY KEY (location, source_key);


--
-- Name: work_index work_index_slug_key; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.work_index
    ADD CONSTRAINT work_index_slug_key UNIQUE (slug) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: work_index_state work_index_state_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.work_index_state
    ADD CONSTRAINT work_index_state_pkey PRIMARY KEY (singleton);


--
-- Name: work_list_dirty work_list_dirty_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.work_list_dirty
    ADD CONSTRAINT work_list_dirty_pkey PRIMARY KEY (slug);


--
-- Name: work_list_state work_list_state_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.work_list_state
    ADD CONSTRAINT work_list_state_pkey PRIMARY KEY (singleton);


--
-- Name: work_list_summary work_list_summary_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.work_list_summary
    ADD CONSTRAINT work_list_summary_pkey PRIMARY KEY (slug);


--
-- Name: work_read_access work_read_access_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.work_read_access
    ADD CONSTRAINT work_read_access_pkey PRIMARY KEY (slug, viewer);


--
-- Name: work_read_dependency work_read_dependency_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.work_read_dependency
    ADD CONSTRAINT work_read_dependency_pkey PRIMARY KEY (slug, node_id);


--
-- Name: work_read_dirty work_read_dirty_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.work_read_dirty
    ADD CONSTRAINT work_read_dirty_pkey PRIMARY KEY (slug);


--
-- Name: work_read_policy work_read_policy_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.work_read_policy
    ADD CONSTRAINT work_read_policy_pkey PRIMARY KEY (slug);


--
-- Name: work_read_questions work_read_questions_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.work_read_questions
    ADD CONSTRAINT work_read_questions_pkey PRIMARY KEY (slug);


--
-- Name: work_read_state work_read_state_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.work_read_state
    ADD CONSTRAINT work_read_state_pkey PRIMARY KEY (singleton);


--
-- Name: work_read_totals work_read_totals_pkey; Type: CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.work_read_totals
    ADD CONSTRAINT work_read_totals_pkey PRIMARY KEY (viewer);


--
-- Name: doc doc_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.doc
    ADD CONSTRAINT doc_pkey PRIMARY KEY (key);


--
-- Name: foreground_asks foreground_asks_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.foreground_asks
    ADD CONSTRAINT foreground_asks_pkey PRIMARY KEY (sect, ord);


--
-- Name: foreground_blobs foreground_blobs_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.foreground_blobs
    ADD CONSTRAINT foreground_blobs_pkey PRIMARY KEY (key);


--
-- Name: foreground_counts foreground_counts_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.foreground_counts
    ADD CONSTRAINT foreground_counts_pkey PRIMARY KEY (source, sect, owner);


--
-- Name: foreground_documents foreground_documents_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.foreground_documents
    ADD CONSTRAINT foreground_documents_pkey PRIMARY KEY (source, seq);


--
-- Name: foreground_meta foreground_meta_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.foreground_meta
    ADD CONSTRAINT foreground_meta_pkey PRIMARY KEY (singleton);


--
-- Name: foreground_parents foreground_parents_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.foreground_parents
    ADD CONSTRAINT foreground_parents_pkey PRIMARY KEY (parent);


--
-- Name: log_d log_d_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.log_d
    ADD CONSTRAINT log_d_pkey PRIMARY KEY (seq);


--
-- Name: log_l log_l_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.log_l
    ADD CONSTRAINT log_l_pkey PRIMARY KEY (seq);


--
-- Name: mail_archive_bounds mail_archive_bounds_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.mail_archive_bounds
    ADD CONSTRAINT mail_archive_bounds_pkey PRIMARY KEY (owner);


--
-- Name: mail_sent mail_sent_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.mail_sent
    ADD CONSTRAINT mail_sent_pkey PRIMARY KEY (seq);


--
-- Name: meta meta_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.meta
    ADD CONSTRAINT meta_pkey PRIMARY KEY (key);


--
-- Name: node_index node_index_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.node_index
    ADD CONSTRAINT node_index_pkey PRIMARY KEY (id);


--
-- Name: node_tree_val node_tree_val_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.node_tree_val
    ADD CONSTRAINT node_tree_val_pkey PRIMARY KEY (id);


--
-- Name: nodes nodes_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.nodes
    ADD CONSTRAINT nodes_pkey PRIMARY KEY (id);


--
-- Name: receipt_carriers receipt_carriers_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.receipt_carriers
    ADD CONSTRAINT receipt_carriers_pkey PRIMARY KEY (owner, carrier, token);


--
-- Name: receipt_format receipt_format_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.receipt_format
    ADD CONSTRAINT receipt_format_pkey PRIMARY KEY (singleton);


--
-- Name: receipt_owners receipt_owners_ord_key; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.receipt_owners
    ADD CONSTRAINT receipt_owners_ord_key UNIQUE (ord);


--
-- Name: receipt_owners receipt_owners_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.receipt_owners
    ADD CONSTRAINT receipt_owners_pkey PRIMARY KEY (owner);


--
-- Name: receipts receipts_owner_ord_key; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.receipts
    ADD CONSTRAINT receipts_owner_ord_key UNIQUE (owner, ord);


--
-- Name: receipts receipts_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.receipts
    ADD CONSTRAINT receipts_pkey PRIMARY KEY (owner, token);


--
-- Name: work_index work_index_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.work_index
    ADD CONSTRAINT work_index_pkey PRIMARY KEY (location, source_key);


--
-- Name: work_index work_index_slug_key; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.work_index
    ADD CONSTRAINT work_index_slug_key UNIQUE (slug) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: work_index_state work_index_state_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.work_index_state
    ADD CONSTRAINT work_index_state_pkey PRIMARY KEY (singleton);


--
-- Name: work_list_dirty work_list_dirty_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.work_list_dirty
    ADD CONSTRAINT work_list_dirty_pkey PRIMARY KEY (slug);


--
-- Name: work_list_state work_list_state_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.work_list_state
    ADD CONSTRAINT work_list_state_pkey PRIMARY KEY (singleton);


--
-- Name: work_list_summary work_list_summary_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.work_list_summary
    ADD CONSTRAINT work_list_summary_pkey PRIMARY KEY (slug);


--
-- Name: work_read_access work_read_access_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.work_read_access
    ADD CONSTRAINT work_read_access_pkey PRIMARY KEY (slug, viewer);


--
-- Name: work_read_dependency work_read_dependency_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.work_read_dependency
    ADD CONSTRAINT work_read_dependency_pkey PRIMARY KEY (slug, node_id);


--
-- Name: work_read_dirty work_read_dirty_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.work_read_dirty
    ADD CONSTRAINT work_read_dirty_pkey PRIMARY KEY (slug);


--
-- Name: work_read_policy work_read_policy_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.work_read_policy
    ADD CONSTRAINT work_read_policy_pkey PRIMARY KEY (slug);


--
-- Name: work_read_questions work_read_questions_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.work_read_questions
    ADD CONSTRAINT work_read_questions_pkey PRIMARY KEY (slug);


--
-- Name: work_read_state work_read_state_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.work_read_state
    ADD CONSTRAINT work_read_state_pkey PRIMARY KEY (singleton);


--
-- Name: work_read_totals work_read_totals_pkey; Type: CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.work_read_totals
    ADD CONSTRAINT work_read_totals_pkey PRIMARY KEY (viewer);


--
-- Name: org_statistics_ready org_statistics_ready_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_statistics_ready
    ADD CONSTRAINT org_statistics_ready_pkey PRIMARY KEY (org_id);


--
-- Name: orgs orgs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orgs
    ADD CONSTRAINT orgs_pkey PRIMARY KEY (org_id);


--
-- Name: orgs orgs_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orgs
    ADD CONSTRAINT orgs_slug_key UNIQUE (slug);


--
-- Name: receipts receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_pkey PRIMARY KEY (org_id, op_key);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (name);


--
-- Name: foreground_asks_node; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX foreground_asks_node ON org_1.foreground_asks USING btree (node, sect, stamp DESC, ord);


--
-- Name: foreground_asks_not_withdrawn; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX foreground_asks_not_withdrawn ON org_1.foreground_asks USING btree (node, sect, stamp DESC, ord) WHERE (status <> 'withdrawn'::text);


--
-- Name: foreground_asks_open; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX foreground_asks_open ON org_1.foreground_asks USING btree (sect, ord) WHERE (status = ANY (ARRAY['open'::text, 'pending'::text]));


--
-- Name: foreground_asks_resolved; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX foreground_asks_resolved ON org_1.foreground_asks USING btree (sect, ord DESC) WHERE (status <> ALL (ARRAY['open'::text, 'pending'::text]));


--
-- Name: foreground_asks_resolved_recent; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX foreground_asks_resolved_recent ON org_1.foreground_asks USING btree (sect, stamp DESC, ord DESC) WHERE (status <> ALL (ARRAY['open'::text, 'pending'::text]));


--
-- Name: foreground_asks_resolved_recent_visible; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX foreground_asks_resolved_recent_visible ON org_1.foreground_asks USING btree (sect, stamp DESC, ord DESC) WHERE ((status <> ALL (ARRAY['open'::text, 'pending'::text])) AND (status <> 'withdrawn'::text));


--
-- Name: foreground_asks_resolved_visible; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX foreground_asks_resolved_visible ON org_1.foreground_asks USING btree (sect, ord DESC) WHERE ((status <> ALL (ARRAY['open'::text, 'pending'::text])) AND (status <> 'withdrawn'::text));


--
-- Name: foreground_documents_node; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX foreground_documents_node ON org_1.foreground_documents USING btree (source, node, seq);


--
-- Name: ix_log_d; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX ix_log_d ON org_1.log_d USING btree (sect, owner, seq);


--
-- Name: ix_log_d_steered_tail; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX ix_log_d_steered_tail ON org_1.log_d USING btree (owner, COALESCE(at, ''::text) COLLATE "C" DESC, seq DESC) WHERE (sect = 'steered_log'::text);


--
-- Name: ix_log_l; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX ix_log_l ON org_1.log_l USING btree (sect, seq);


--
-- Name: ix_log_l_present_evicted; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX ix_log_l_present_evicted ON org_1.log_l USING btree (seq) WHERE ((sect = 'events'::text) AND (strpos(val, 'present_evicted'::text) > 0));


--
-- Name: ix_mail_ordinal; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX ix_mail_ordinal ON org_1.log_d USING btree (owner, public.orgtree_mail_ordinal(val) DESC) WHERE (sect = 'mail_log'::text);


--
-- Name: ix_mail_sent_owner; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX ix_mail_sent_owner ON org_1.mail_sent USING btree (owner, seq);


--
-- Name: ix_mail_sent_tail; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX ix_mail_sent_tail ON org_1.mail_sent USING btree (sender, sent_at DESC, owner_pos DESC, seq DESC);


--
-- Name: ix_policy_candidates; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX ix_policy_candidates ON org_1.nodes USING btree (ord, id) WHERE ((((val)::jsonb ->> 'state'::text) = 'live'::text) OR (COALESCE(((val)::jsonb -> 'frozen'::text), 'null'::jsonb) <> ALL (ARRAY['null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb])));


--
-- Name: ix_policy_settings; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX ix_policy_settings ON org_1.doc USING btree (key) WHERE ((strpos(key, chr(31)) = 0) AND (key <> ALL (ARRAY['nodes'::text, 'work_items'::text, 'mail'::text, 'delivering'::text, 'notices'::text, 'mail_log'::text, 'steered_log'::text, 'turn_error_log'::text, 'steer_attempts'::text, 'work_scope_log'::text, 'events'::text, 'org_inbox'::text, 'notice_log'::text, 'user_mail_log'::text, 'user_outbox'::text, 'documents'::text, 'watchdog_history'::text, 'op_receipts'::text, 'work_items_archive'::text, 'lifecycle'::text, 'watchdogs'::text, 'watchdog_tombs'::text, 'reservations'::text, 'credit_requests'::text])));


--
-- Name: ix_receipt_carriers_operation; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX ix_receipt_carriers_operation ON org_1.receipt_carriers USING btree (owner, token);


--
-- Name: ix_user_mail_sender; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX ix_user_mail_sender ON org_1.log_l USING btree (public.json_extract(val, VARIADIC ARRAY['$.from'::text]), COALESCE(public.json_extract(val, VARIADIC ARRAY['$.at'::text]), ''::text) DESC, seq DESC) WHERE (sect = 'user_mail_log'::text);


--
-- Name: node_index_active; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX node_index_active ON org_1.node_index USING btree (ord, id) WHERE ((meta ->> 'state'::text) <> 'archived'::text);


--
-- Name: node_index_children; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX node_index_children ON org_1.node_index USING btree (((meta ->> 'parent'::text)), (((meta ->> 'order'::text))::numeric), ((meta ->> 'created'::text)), ord, id) WHERE (((meta ->> 'state'::text) = 'archived'::text) AND ((meta ->> 'successor'::text) = ''::text));


--
-- Name: node_index_discovery; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX node_index_discovery ON org_1.node_index USING btree (((meta ->> 'state'::text)), id COLLATE "C");


--
-- Name: node_index_predecessor; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX node_index_predecessor ON org_1.node_index USING btree (((meta ->> 'predecessor'::text)));


--
-- Name: node_index_search; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX node_index_search ON org_1.node_index USING gin (public.orgtree_id_grams(id));


--
-- Name: nodes_summary_cost_exceptions; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX nodes_summary_cost_exceptions ON org_1.nodes USING btree (id) WHERE public.orgtree_summary_cost_exception(val);


--
-- Name: work_index_order; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX work_index_order ON org_1.work_index USING btree (((summary ->> 'docket_at'::text)), slug);


--
-- Name: work_index_status; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX work_index_status ON org_1.work_index USING btree (((summary ->> 'status'::text)), slug);


--
-- Name: work_query_order; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX work_query_order ON org_1.work_index USING btree (COALESCE(NULLIF((summary ->> 'docket_at'::text), ''::text), (summary ->> 'updated_at'::text), ''::text) COLLATE "C", slug COLLATE "C");


--
-- Name: work_query_unsupported; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX work_query_unsupported ON org_1.work_index USING btree (slug) WHERE ((((summary -> '_query'::text) ->> 'format'::text) IS DISTINCT FROM 'orgtree.work-query/v1'::text) OR (((summary -> '_query'::text) ->> 'legacy_identity'::text) IS DISTINCT FROM 'false'::text) OR (((summary -> '_query'::text) ->> 'order_supported'::text) IS DISTINCT FROM 'true'::text));


--
-- Name: work_read_deadline; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX work_read_deadline ON org_1.work_read_policy USING btree (deadline, slug) WHERE ((location = 'active'::text) AND (deadline IS NOT NULL));


--
-- Name: work_read_forever; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX work_read_forever ON org_1.work_read_policy USING btree (slug) WHERE ((location = 'active'::text) AND (deadline IS NULL));


--
-- Name: work_read_manual; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX work_read_manual ON org_1.work_read_policy USING btree (slug) WHERE manual;


--
-- Name: work_read_node; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX work_read_node ON org_1.work_read_dependency USING btree (node_id, slug);


--
-- Name: work_read_viewer; Type: INDEX; Schema: org_1; Owner: -
--

CREATE INDEX work_read_viewer ON org_1.work_read_access USING btree (viewer, slug);


--
-- Name: foreground_asks_node; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX foreground_asks_node ON org_2.foreground_asks USING btree (node, sect, stamp DESC, ord);


--
-- Name: foreground_asks_not_withdrawn; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX foreground_asks_not_withdrawn ON org_2.foreground_asks USING btree (node, sect, stamp DESC, ord) WHERE (status <> 'withdrawn'::text);


--
-- Name: foreground_asks_open; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX foreground_asks_open ON org_2.foreground_asks USING btree (sect, ord) WHERE (status = ANY (ARRAY['open'::text, 'pending'::text]));


--
-- Name: foreground_asks_resolved; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX foreground_asks_resolved ON org_2.foreground_asks USING btree (sect, ord DESC) WHERE (status <> ALL (ARRAY['open'::text, 'pending'::text]));


--
-- Name: foreground_asks_resolved_recent; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX foreground_asks_resolved_recent ON org_2.foreground_asks USING btree (sect, stamp DESC, ord DESC) WHERE (status <> ALL (ARRAY['open'::text, 'pending'::text]));


--
-- Name: foreground_asks_resolved_recent_visible; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX foreground_asks_resolved_recent_visible ON org_2.foreground_asks USING btree (sect, stamp DESC, ord DESC) WHERE ((status <> ALL (ARRAY['open'::text, 'pending'::text])) AND (status <> 'withdrawn'::text));


--
-- Name: foreground_asks_resolved_visible; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX foreground_asks_resolved_visible ON org_2.foreground_asks USING btree (sect, ord DESC) WHERE ((status <> ALL (ARRAY['open'::text, 'pending'::text])) AND (status <> 'withdrawn'::text));


--
-- Name: foreground_documents_node; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX foreground_documents_node ON org_2.foreground_documents USING btree (source, node, seq);


--
-- Name: ix_log_d; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX ix_log_d ON org_2.log_d USING btree (sect, owner, seq);


--
-- Name: ix_log_d_steered_tail; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX ix_log_d_steered_tail ON org_2.log_d USING btree (owner, COALESCE(at, ''::text) COLLATE "C" DESC, seq DESC) WHERE (sect = 'steered_log'::text);


--
-- Name: ix_log_l; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX ix_log_l ON org_2.log_l USING btree (sect, seq);


--
-- Name: ix_log_l_present_evicted; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX ix_log_l_present_evicted ON org_2.log_l USING btree (seq) WHERE ((sect = 'events'::text) AND (strpos(val, 'present_evicted'::text) > 0));


--
-- Name: ix_mail_ordinal; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX ix_mail_ordinal ON org_2.log_d USING btree (owner, public.orgtree_mail_ordinal(val) DESC) WHERE (sect = 'mail_log'::text);


--
-- Name: ix_mail_sent_owner; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX ix_mail_sent_owner ON org_2.mail_sent USING btree (owner, seq);


--
-- Name: ix_mail_sent_tail; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX ix_mail_sent_tail ON org_2.mail_sent USING btree (sender, sent_at DESC, owner_pos DESC, seq DESC);


--
-- Name: ix_policy_candidates; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX ix_policy_candidates ON org_2.nodes USING btree (ord, id) WHERE ((((val)::jsonb ->> 'state'::text) = 'live'::text) OR (COALESCE(((val)::jsonb -> 'frozen'::text), 'null'::jsonb) <> ALL (ARRAY['null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb])));


--
-- Name: ix_policy_settings; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX ix_policy_settings ON org_2.doc USING btree (key) WHERE ((strpos(key, chr(31)) = 0) AND (key <> ALL (ARRAY['nodes'::text, 'work_items'::text, 'mail'::text, 'delivering'::text, 'notices'::text, 'mail_log'::text, 'steered_log'::text, 'turn_error_log'::text, 'steer_attempts'::text, 'work_scope_log'::text, 'events'::text, 'org_inbox'::text, 'notice_log'::text, 'user_mail_log'::text, 'user_outbox'::text, 'documents'::text, 'watchdog_history'::text, 'op_receipts'::text, 'work_items_archive'::text, 'lifecycle'::text, 'watchdogs'::text, 'watchdog_tombs'::text, 'reservations'::text, 'credit_requests'::text])));


--
-- Name: ix_receipt_carriers_operation; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX ix_receipt_carriers_operation ON org_2.receipt_carriers USING btree (owner, token);


--
-- Name: ix_user_mail_sender; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX ix_user_mail_sender ON org_2.log_l USING btree (public.json_extract(val, VARIADIC ARRAY['$.from'::text]), COALESCE(public.json_extract(val, VARIADIC ARRAY['$.at'::text]), ''::text) DESC, seq DESC) WHERE (sect = 'user_mail_log'::text);


--
-- Name: node_index_active; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX node_index_active ON org_2.node_index USING btree (ord, id) WHERE ((meta ->> 'state'::text) <> 'archived'::text);


--
-- Name: node_index_children; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX node_index_children ON org_2.node_index USING btree (((meta ->> 'parent'::text)), (((meta ->> 'order'::text))::numeric), ((meta ->> 'created'::text)), ord, id) WHERE (((meta ->> 'state'::text) = 'archived'::text) AND ((meta ->> 'successor'::text) = ''::text));


--
-- Name: node_index_discovery; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX node_index_discovery ON org_2.node_index USING btree (((meta ->> 'state'::text)), id COLLATE "C");


--
-- Name: node_index_predecessor; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX node_index_predecessor ON org_2.node_index USING btree (((meta ->> 'predecessor'::text)));


--
-- Name: node_index_search; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX node_index_search ON org_2.node_index USING gin (public.orgtree_id_grams(id));


--
-- Name: nodes_summary_cost_exceptions; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX nodes_summary_cost_exceptions ON org_2.nodes USING btree (id) WHERE public.orgtree_summary_cost_exception(val);


--
-- Name: work_index_order; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX work_index_order ON org_2.work_index USING btree (((summary ->> 'docket_at'::text)), slug);


--
-- Name: work_index_status; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX work_index_status ON org_2.work_index USING btree (((summary ->> 'status'::text)), slug);


--
-- Name: work_query_order; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX work_query_order ON org_2.work_index USING btree (COALESCE(NULLIF((summary ->> 'docket_at'::text), ''::text), (summary ->> 'updated_at'::text), ''::text) COLLATE "C", slug COLLATE "C");


--
-- Name: work_query_unsupported; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX work_query_unsupported ON org_2.work_index USING btree (slug) WHERE ((((summary -> '_query'::text) ->> 'format'::text) IS DISTINCT FROM 'orgtree.work-query/v1'::text) OR (((summary -> '_query'::text) ->> 'legacy_identity'::text) IS DISTINCT FROM 'false'::text) OR (((summary -> '_query'::text) ->> 'order_supported'::text) IS DISTINCT FROM 'true'::text));


--
-- Name: work_read_deadline; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX work_read_deadline ON org_2.work_read_policy USING btree (deadline, slug) WHERE ((location = 'active'::text) AND (deadline IS NOT NULL));


--
-- Name: work_read_forever; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX work_read_forever ON org_2.work_read_policy USING btree (slug) WHERE ((location = 'active'::text) AND (deadline IS NULL));


--
-- Name: work_read_manual; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX work_read_manual ON org_2.work_read_policy USING btree (slug) WHERE manual;


--
-- Name: work_read_node; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX work_read_node ON org_2.work_read_dependency USING btree (node_id, slug);


--
-- Name: work_read_viewer; Type: INDEX; Schema: org_2; Owner: -
--

CREATE INDEX work_read_viewer ON org_2.work_read_access USING btree (viewer, slug);


--
-- Name: doc foreground_doc_commit; Type: TRIGGER; Schema: org_1; Owner: -
--

CREATE CONSTRAINT TRIGGER foreground_doc_commit AFTER INSERT OR DELETE OR UPDATE ON org_1.doc DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.orgtree_foreground_doc_commit();


--
-- Name: log_l foreground_log_commit; Type: TRIGGER; Schema: org_1; Owner: -
--

CREATE CONSTRAINT TRIGGER foreground_log_commit AFTER INSERT OR DELETE OR UPDATE ON org_1.log_l DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.orgtree_foreground_log_commit();


--
-- Name: nodes foreground_node_commit; Type: TRIGGER; Schema: org_1; Owner: -
--

CREATE CONSTRAINT TRIGGER foreground_node_commit AFTER INSERT OR DELETE OR UPDATE ON org_1.nodes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.orgtree_foreground_node_commit();


--
-- Name: nodes foreground_tree_val_commit; Type: TRIGGER; Schema: org_1; Owner: -
--

CREATE CONSTRAINT TRIGGER foreground_tree_val_commit AFTER INSERT OR DELETE OR UPDATE ON org_1.nodes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.orgtree_foreground_tree_val_commit();


--
-- Name: log_d mail_archive_bounds; Type: TRIGGER; Schema: org_1; Owner: -
--

CREATE TRIGGER mail_archive_bounds AFTER INSERT OR DELETE OR UPDATE ON org_1.log_d FOR EACH ROW EXECUTE FUNCTION public.orgtree_track_mail_archive();


--
-- Name: log_d mail_archive_prepare; Type: TRIGGER; Schema: org_1; Owner: -
--

CREATE TRIGGER mail_archive_prepare BEFORE INSERT OR DELETE OR UPDATE ON org_1.log_d FOR EACH ROW EXECUTE FUNCTION public.orgtree_track_mail_archive();


--
-- Name: log_d mail_archive_truncate; Type: TRIGGER; Schema: org_1; Owner: -
--

CREATE TRIGGER mail_archive_truncate AFTER TRUNCATE ON org_1.log_d FOR EACH STATEMENT EXECUTE FUNCTION public.orgtree_truncate_mail_archive();


--
-- Name: log_d mail_sent_truncate; Type: TRIGGER; Schema: org_1; Owner: -
--

CREATE TRIGGER mail_sent_truncate AFTER TRUNCATE ON org_1.log_d FOR EACH STATEMENT EXECUTE FUNCTION public.orgtree_truncate_mail_sent();


--
-- Name: log_d mail_sent_update; Type: TRIGGER; Schema: org_1; Owner: -
--

CREATE TRIGGER mail_sent_update AFTER INSERT OR DELETE OR UPDATE ON org_1.log_d FOR EACH ROW EXECUTE FUNCTION public.orgtree_track_mail_sent();


--
-- Name: doc work_access_doc; Type: TRIGGER; Schema: org_1; Owner: -
--

CREATE TRIGGER work_access_doc AFTER INSERT OR DELETE OR UPDATE ON org_1.doc FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_access_dirty();


--
-- Name: work_index work_access_item; Type: TRIGGER; Schema: org_1; Owner: -
--

CREATE TRIGGER work_access_item AFTER INSERT OR DELETE OR UPDATE ON org_1.work_index FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_access_dirty();


--
-- Name: nodes work_access_node; Type: TRIGGER; Schema: org_1; Owner: -
--

CREATE TRIGGER work_access_node AFTER INSERT OR DELETE OR UPDATE ON org_1.nodes FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_access_dirty();


--
-- Name: doc work_index_doc; Type: TRIGGER; Schema: org_1; Owner: -
--

CREATE TRIGGER work_index_doc AFTER INSERT OR DELETE OR UPDATE ON org_1.doc FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_index_row();


--
-- Name: log_l work_index_log; Type: TRIGGER; Schema: org_1; Owner: -
--

CREATE TRIGGER work_index_log AFTER INSERT OR DELETE OR UPDATE ON org_1.log_l FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_index_row();


--
-- Name: doc work_list_doc; Type: TRIGGER; Schema: org_1; Owner: -
--

CREATE TRIGGER work_list_doc AFTER INSERT OR DELETE OR UPDATE ON org_1.doc FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_list_dirty();


--
-- Name: work_index work_list_item; Type: TRIGGER; Schema: org_1; Owner: -
--

CREATE TRIGGER work_list_item AFTER INSERT OR DELETE OR UPDATE ON org_1.work_index FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_list_dirty();


--
-- Name: nodes work_list_node; Type: TRIGGER; Schema: org_1; Owner: -
--

CREATE TRIGGER work_list_node AFTER INSERT OR DELETE OR UPDATE ON org_1.nodes FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_list_dirty();


--
-- Name: log_d work_list_scope; Type: TRIGGER; Schema: org_1; Owner: -
--

CREATE TRIGGER work_list_scope AFTER INSERT OR DELETE OR UPDATE ON org_1.log_d FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_list_dirty();


--
-- Name: doc foreground_doc_commit; Type: TRIGGER; Schema: org_2; Owner: -
--

CREATE CONSTRAINT TRIGGER foreground_doc_commit AFTER INSERT OR DELETE OR UPDATE ON org_2.doc DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.orgtree_foreground_doc_commit();


--
-- Name: log_l foreground_log_commit; Type: TRIGGER; Schema: org_2; Owner: -
--

CREATE CONSTRAINT TRIGGER foreground_log_commit AFTER INSERT OR DELETE OR UPDATE ON org_2.log_l DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.orgtree_foreground_log_commit();


--
-- Name: nodes foreground_node_commit; Type: TRIGGER; Schema: org_2; Owner: -
--

CREATE CONSTRAINT TRIGGER foreground_node_commit AFTER INSERT OR DELETE OR UPDATE ON org_2.nodes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.orgtree_foreground_node_commit();


--
-- Name: nodes foreground_tree_val_commit; Type: TRIGGER; Schema: org_2; Owner: -
--

CREATE CONSTRAINT TRIGGER foreground_tree_val_commit AFTER INSERT OR DELETE OR UPDATE ON org_2.nodes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.orgtree_foreground_tree_val_commit();


--
-- Name: log_d mail_archive_bounds; Type: TRIGGER; Schema: org_2; Owner: -
--

CREATE TRIGGER mail_archive_bounds AFTER INSERT OR DELETE OR UPDATE ON org_2.log_d FOR EACH ROW EXECUTE FUNCTION public.orgtree_track_mail_archive();


--
-- Name: log_d mail_archive_prepare; Type: TRIGGER; Schema: org_2; Owner: -
--

CREATE TRIGGER mail_archive_prepare BEFORE INSERT OR DELETE OR UPDATE ON org_2.log_d FOR EACH ROW EXECUTE FUNCTION public.orgtree_track_mail_archive();


--
-- Name: log_d mail_archive_truncate; Type: TRIGGER; Schema: org_2; Owner: -
--

CREATE TRIGGER mail_archive_truncate AFTER TRUNCATE ON org_2.log_d FOR EACH STATEMENT EXECUTE FUNCTION public.orgtree_truncate_mail_archive();


--
-- Name: log_d mail_sent_truncate; Type: TRIGGER; Schema: org_2; Owner: -
--

CREATE TRIGGER mail_sent_truncate AFTER TRUNCATE ON org_2.log_d FOR EACH STATEMENT EXECUTE FUNCTION public.orgtree_truncate_mail_sent();


--
-- Name: log_d mail_sent_update; Type: TRIGGER; Schema: org_2; Owner: -
--

CREATE TRIGGER mail_sent_update AFTER INSERT OR DELETE OR UPDATE ON org_2.log_d FOR EACH ROW EXECUTE FUNCTION public.orgtree_track_mail_sent();


--
-- Name: doc work_access_doc; Type: TRIGGER; Schema: org_2; Owner: -
--

CREATE TRIGGER work_access_doc AFTER INSERT OR DELETE OR UPDATE ON org_2.doc FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_access_dirty();


--
-- Name: work_index work_access_item; Type: TRIGGER; Schema: org_2; Owner: -
--

CREATE TRIGGER work_access_item AFTER INSERT OR DELETE OR UPDATE ON org_2.work_index FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_access_dirty();


--
-- Name: nodes work_access_node; Type: TRIGGER; Schema: org_2; Owner: -
--

CREATE TRIGGER work_access_node AFTER INSERT OR DELETE OR UPDATE ON org_2.nodes FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_access_dirty();


--
-- Name: doc work_index_doc; Type: TRIGGER; Schema: org_2; Owner: -
--

CREATE TRIGGER work_index_doc AFTER INSERT OR DELETE OR UPDATE ON org_2.doc FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_index_row();


--
-- Name: log_l work_index_log; Type: TRIGGER; Schema: org_2; Owner: -
--

CREATE TRIGGER work_index_log AFTER INSERT OR DELETE OR UPDATE ON org_2.log_l FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_index_row();


--
-- Name: doc work_list_doc; Type: TRIGGER; Schema: org_2; Owner: -
--

CREATE TRIGGER work_list_doc AFTER INSERT OR DELETE OR UPDATE ON org_2.doc FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_list_dirty();


--
-- Name: work_index work_list_item; Type: TRIGGER; Schema: org_2; Owner: -
--

CREATE TRIGGER work_list_item AFTER INSERT OR DELETE OR UPDATE ON org_2.work_index FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_list_dirty();


--
-- Name: nodes work_list_node; Type: TRIGGER; Schema: org_2; Owner: -
--

CREATE TRIGGER work_list_node AFTER INSERT OR DELETE OR UPDATE ON org_2.nodes FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_list_dirty();


--
-- Name: log_d work_list_scope; Type: TRIGGER; Schema: org_2; Owner: -
--

CREATE TRIGGER work_list_scope AFTER INSERT OR DELETE OR UPDATE ON org_2.log_d FOR EACH ROW EXECUTE FUNCTION public.orgtree_work_list_dirty();


--
-- Name: receipt_carriers receipt_carriers_owner_token_fkey; Type: FK CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.receipt_carriers
    ADD CONSTRAINT receipt_carriers_owner_token_fkey FOREIGN KEY (owner, token) REFERENCES org_1.receipts(owner, token);


--
-- Name: receipts receipts_owner_fkey; Type: FK CONSTRAINT; Schema: org_1; Owner: -
--

ALTER TABLE ONLY org_1.receipts
    ADD CONSTRAINT receipts_owner_fkey FOREIGN KEY (owner) REFERENCES org_1.receipt_owners(owner);


--
-- Name: receipt_carriers receipt_carriers_owner_token_fkey; Type: FK CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.receipt_carriers
    ADD CONSTRAINT receipt_carriers_owner_token_fkey FOREIGN KEY (owner, token) REFERENCES org_2.receipts(owner, token);


--
-- Name: receipts receipts_owner_fkey; Type: FK CONSTRAINT; Schema: org_2; Owner: -
--

ALTER TABLE ONLY org_2.receipts
    ADD CONSTRAINT receipts_owner_fkey FOREIGN KEY (owner) REFERENCES org_2.receipt_owners(owner);


--
-- Name: org_statistics_ready org_statistics_ready_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_statistics_ready
    ADD CONSTRAINT org_statistics_ready_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(org_id) ON DELETE CASCADE;


--
-- Name: receipts receipts_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(org_id);


--
-- Name: SCHEMA org_1; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA org_1 TO orgtree_runtime;


--
-- Name: SCHEMA org_2; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA org_2 TO orgtree_runtime;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO orgtree_runtime;


--
-- Name: FUNCTION json_extract(v text, VARIADIC paths text[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.json_extract(v text, VARIADIC paths text[]) TO orgtree_runtime;


--
-- Name: FUNCTION orgtree_analyze_org(p_org_id bigint, p_force boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_analyze_org(p_org_id bigint, p_force boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.orgtree_analyze_org(p_org_id bigint, p_force boolean) TO orgtree_runtime;


--
-- Name: FUNCTION orgtree_create_org_schema(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_create_org_schema(p_org_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.orgtree_create_org_schema(p_org_id bigint) TO orgtree_runtime;


--
-- Name: FUNCTION orgtree_create_org_schema_before_asks_resolved_recent(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_asks_resolved_recent(p_org_id bigint) FROM PUBLIC;


--
-- Name: FUNCTION orgtree_create_org_schema_before_mail_bounds(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_mail_bounds(p_org_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.orgtree_create_org_schema_before_mail_bounds(p_org_id bigint) TO orgtree_runtime;


--
-- Name: FUNCTION orgtree_create_org_schema_before_mail_sent(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_mail_sent(p_org_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.orgtree_create_org_schema_before_mail_sent(p_org_id bigint) TO orgtree_runtime;


--
-- Name: FUNCTION orgtree_create_org_schema_before_policy_candidates(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_policy_candidates(p_org_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.orgtree_create_org_schema_before_policy_candidates(p_org_id bigint) TO orgtree_runtime;


--
-- Name: FUNCTION orgtree_create_org_schema_before_present_evicted(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_present_evicted(p_org_id bigint) FROM PUBLIC;


--
-- Name: FUNCTION orgtree_create_org_schema_before_receipts(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_receipts(p_org_id bigint) FROM PUBLIC;


--
-- Name: FUNCTION orgtree_create_org_schema_before_steered_tail(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_steered_tail(p_org_id bigint) FROM PUBLIC;


--
-- Name: FUNCTION orgtree_create_org_schema_before_summary_cost(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_summary_cost(p_org_id bigint) FROM PUBLIC;


--
-- Name: FUNCTION orgtree_create_org_schema_before_tree_val(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_tree_val(p_org_id bigint) FROM PUBLIC;


--
-- Name: FUNCTION orgtree_create_org_schema_before_work_access(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_work_access(p_org_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.orgtree_create_org_schema_before_work_access(p_org_id bigint) TO orgtree_runtime;


--
-- Name: FUNCTION orgtree_create_org_schema_before_work_index(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_work_index(p_org_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.orgtree_create_org_schema_before_work_index(p_org_id bigint) TO orgtree_runtime;


--
-- Name: FUNCTION orgtree_create_org_schema_before_work_list(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_work_list(p_org_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.orgtree_create_org_schema_before_work_list(p_org_id bigint) TO orgtree_runtime;


--
-- Name: FUNCTION orgtree_create_org_schema_before_work_query(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_work_query(p_org_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.orgtree_create_org_schema_before_work_query(p_org_id bigint) TO orgtree_runtime;


--
-- Name: FUNCTION orgtree_create_org_schema_v3(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_v3(p_org_id bigint) FROM PUBLIC;


--
-- Name: FUNCTION orgtree_delete_receipt(p_org_id bigint, p_owner text, p_token text, p_expected text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_delete_receipt(p_org_id bigint, p_owner text, p_token text, p_expected text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.orgtree_delete_receipt(p_org_id bigint, p_owner text, p_token text, p_expected text) TO orgtree_runtime;


--
-- Name: FUNCTION orgtree_install_asks_resolved_recent(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_install_asks_resolved_recent(p_org_id bigint) FROM PUBLIC;


--
-- Name: FUNCTION orgtree_install_foreground_index(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_install_foreground_index(p_org_id bigint) FROM PUBLIC;


--
-- Name: FUNCTION orgtree_install_policy_candidates(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_install_policy_candidates(p_org_id bigint) FROM PUBLIC;


--
-- Name: FUNCTION orgtree_install_present_evicted(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_install_present_evicted(p_org_id bigint) FROM PUBLIC;


--
-- Name: FUNCTION orgtree_install_receipt_rows(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_install_receipt_rows(p_org_id bigint) FROM PUBLIC;


--
-- Name: FUNCTION orgtree_install_steered_log_tail(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_install_steered_log_tail(p_org_id bigint) FROM PUBLIC;


--
-- Name: FUNCTION orgtree_install_summary_cost_index(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_install_summary_cost_index(p_org_id bigint) FROM PUBLIC;


--
-- Name: FUNCTION orgtree_install_tree_val(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_install_tree_val(p_org_id bigint) FROM PUBLIC;


--
-- Name: FUNCTION orgtree_install_work_access(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_install_work_access(p_org_id bigint) FROM PUBLIC;


--
-- Name: FUNCTION orgtree_install_work_index(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_install_work_index(p_org_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.orgtree_install_work_index(p_org_id bigint) TO orgtree_runtime;


--
-- Name: FUNCTION orgtree_install_work_list(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_install_work_list(p_org_id bigint) FROM PUBLIC;


--
-- Name: FUNCTION orgtree_install_work_query(p_org_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_install_work_query(p_org_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.orgtree_install_work_query(p_org_id bigint) TO orgtree_runtime;


--
-- Name: FUNCTION orgtree_put_receipt(p_org_id bigint, p_owner text, p_token text, p_value text, p_expected text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.orgtree_put_receipt(p_org_id bigint, p_owner text, p_token text, p_value text, p_expected text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.orgtree_put_receipt(p_org_id bigint, p_owner text, p_token text, p_value text, p_expected text) TO orgtree_runtime;


--
-- Name: TABLE doc; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.doc TO orgtree_runtime;


--
-- Name: TABLE foreground_asks; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.foreground_asks TO orgtree_runtime;


--
-- Name: TABLE foreground_blobs; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.foreground_blobs TO orgtree_runtime;


--
-- Name: TABLE foreground_counts; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.foreground_counts TO orgtree_runtime;


--
-- Name: TABLE foreground_documents; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.foreground_documents TO orgtree_runtime;


--
-- Name: TABLE foreground_meta; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.foreground_meta TO orgtree_runtime;


--
-- Name: TABLE foreground_parents; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.foreground_parents TO orgtree_runtime;


--
-- Name: TABLE log_d; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.log_d TO orgtree_runtime;


--
-- Name: SEQUENCE log_d_seq_seq; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE org_1.log_d_seq_seq TO orgtree_runtime;


--
-- Name: TABLE log_l; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.log_l TO orgtree_runtime;


--
-- Name: SEQUENCE log_l_seq_seq; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE org_1.log_l_seq_seq TO orgtree_runtime;


--
-- Name: TABLE mail_archive_bounds; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.mail_archive_bounds TO orgtree_runtime;


--
-- Name: TABLE mail_sent; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.mail_sent TO orgtree_runtime;


--
-- Name: TABLE meta; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.meta TO orgtree_runtime;


--
-- Name: TABLE node_index; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.node_index TO orgtree_runtime;


--
-- Name: TABLE node_tree_val; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.node_tree_val TO orgtree_runtime;


--
-- Name: TABLE nodes; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.nodes TO orgtree_runtime;


--
-- Name: TABLE receipt_carriers; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,TRUNCATE,UPDATE ON TABLE org_1.receipt_carriers TO orgtree_runtime;


--
-- Name: TABLE receipt_format; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,TRUNCATE,UPDATE ON TABLE org_1.receipt_format TO orgtree_runtime;


--
-- Name: SEQUENCE receipt_owner_versions; Type: ACL; Schema: org_1; Owner: -
--

GRANT ALL ON SEQUENCE org_1.receipt_owner_versions TO orgtree_runtime;


--
-- Name: TABLE receipt_owners; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,TRUNCATE,UPDATE ON TABLE org_1.receipt_owners TO orgtree_runtime;


--
-- Name: SEQUENCE receipt_owners_ord_seq; Type: ACL; Schema: org_1; Owner: -
--

GRANT ALL ON SEQUENCE org_1.receipt_owners_ord_seq TO orgtree_runtime;


--
-- Name: TABLE receipts; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,TRUNCATE,UPDATE ON TABLE org_1.receipts TO orgtree_runtime;


--
-- Name: TABLE work_index; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.work_index TO orgtree_runtime;


--
-- Name: TABLE work_index_state; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.work_index_state TO orgtree_runtime;


--
-- Name: TABLE work_list_dirty; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.work_list_dirty TO orgtree_runtime;


--
-- Name: TABLE work_list_state; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.work_list_state TO orgtree_runtime;


--
-- Name: TABLE work_list_summary; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.work_list_summary TO orgtree_runtime;


--
-- Name: TABLE work_read_access; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.work_read_access TO orgtree_runtime;


--
-- Name: TABLE work_read_dependency; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.work_read_dependency TO orgtree_runtime;


--
-- Name: TABLE work_read_dirty; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.work_read_dirty TO orgtree_runtime;


--
-- Name: TABLE work_read_policy; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.work_read_policy TO orgtree_runtime;


--
-- Name: TABLE work_read_questions; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.work_read_questions TO orgtree_runtime;


--
-- Name: TABLE work_read_state; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.work_read_state TO orgtree_runtime;


--
-- Name: TABLE work_read_totals; Type: ACL; Schema: org_1; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_1.work_read_totals TO orgtree_runtime;


--
-- Name: TABLE doc; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.doc TO orgtree_runtime;


--
-- Name: TABLE foreground_asks; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.foreground_asks TO orgtree_runtime;


--
-- Name: TABLE foreground_blobs; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.foreground_blobs TO orgtree_runtime;


--
-- Name: TABLE foreground_counts; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.foreground_counts TO orgtree_runtime;


--
-- Name: TABLE foreground_documents; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.foreground_documents TO orgtree_runtime;


--
-- Name: TABLE foreground_meta; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.foreground_meta TO orgtree_runtime;


--
-- Name: TABLE foreground_parents; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.foreground_parents TO orgtree_runtime;


--
-- Name: TABLE log_d; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.log_d TO orgtree_runtime;


--
-- Name: SEQUENCE log_d_seq_seq; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE org_2.log_d_seq_seq TO orgtree_runtime;


--
-- Name: TABLE log_l; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.log_l TO orgtree_runtime;


--
-- Name: SEQUENCE log_l_seq_seq; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE org_2.log_l_seq_seq TO orgtree_runtime;


--
-- Name: TABLE mail_archive_bounds; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.mail_archive_bounds TO orgtree_runtime;


--
-- Name: TABLE mail_sent; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.mail_sent TO orgtree_runtime;


--
-- Name: TABLE meta; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.meta TO orgtree_runtime;


--
-- Name: TABLE node_index; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.node_index TO orgtree_runtime;


--
-- Name: TABLE node_tree_val; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.node_tree_val TO orgtree_runtime;


--
-- Name: TABLE nodes; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.nodes TO orgtree_runtime;


--
-- Name: TABLE receipt_carriers; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,TRUNCATE,UPDATE ON TABLE org_2.receipt_carriers TO orgtree_runtime;


--
-- Name: TABLE receipt_format; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,TRUNCATE,UPDATE ON TABLE org_2.receipt_format TO orgtree_runtime;


--
-- Name: SEQUENCE receipt_owner_versions; Type: ACL; Schema: org_2; Owner: -
--

GRANT ALL ON SEQUENCE org_2.receipt_owner_versions TO orgtree_runtime;


--
-- Name: TABLE receipt_owners; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,TRUNCATE,UPDATE ON TABLE org_2.receipt_owners TO orgtree_runtime;


--
-- Name: SEQUENCE receipt_owners_ord_seq; Type: ACL; Schema: org_2; Owner: -
--

GRANT ALL ON SEQUENCE org_2.receipt_owners_ord_seq TO orgtree_runtime;


--
-- Name: TABLE receipts; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,TRUNCATE,UPDATE ON TABLE org_2.receipts TO orgtree_runtime;


--
-- Name: TABLE work_index; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.work_index TO orgtree_runtime;


--
-- Name: TABLE work_index_state; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.work_index_state TO orgtree_runtime;


--
-- Name: TABLE work_list_dirty; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.work_list_dirty TO orgtree_runtime;


--
-- Name: TABLE work_list_state; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.work_list_state TO orgtree_runtime;


--
-- Name: TABLE work_list_summary; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.work_list_summary TO orgtree_runtime;


--
-- Name: TABLE work_read_access; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.work_read_access TO orgtree_runtime;


--
-- Name: TABLE work_read_dependency; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.work_read_dependency TO orgtree_runtime;


--
-- Name: TABLE work_read_dirty; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.work_read_dirty TO orgtree_runtime;


--
-- Name: TABLE work_read_policy; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.work_read_policy TO orgtree_runtime;


--
-- Name: TABLE work_read_questions; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.work_read_questions TO orgtree_runtime;


--
-- Name: TABLE work_read_state; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.work_read_state TO orgtree_runtime;


--
-- Name: TABLE work_read_totals; Type: ACL; Schema: org_2; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE org_2.work_read_totals TO orgtree_runtime;


--
-- Name: TABLE orgs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.orgs TO orgtree_runtime;


--
-- Name: SEQUENCE orgs_org_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.orgs_org_id_seq TO orgtree_runtime;


--
-- Name: TABLE receipts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.receipts TO orgtree_runtime;


--
-- Name: TABLE schema_migrations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.schema_migrations TO orgtree_runtime;


--
-- PostgreSQL database dump complete
--

\unrestrict yGwm1duBn04f49xMYrpD2YIaZbvWg5BpMTktu77GxOkv862aJ3FOuFpQ01ESA3M
