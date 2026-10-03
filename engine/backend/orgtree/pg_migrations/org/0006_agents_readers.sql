-- A1: native foreground stamps. Statement triggers collect transaction-local
-- deltas; deferred triggers lock the singleton only after the writer's rows.
ALTER TABLE orgtree.org_revision
  ADD COLUMN node_rev bigint NOT NULL DEFAULT 0,
  ADD COLUMN catalog_rev bigint NOT NULL DEFAULT 0,
  ADD COLUMN view_rev bigint NOT NULL DEFAULT 0;

-- The codec omits *_text for canonical UTC milliseconds; keep legacy's text
-- order for noncanonical strings without converting JSON or loading bodies.
CREATE FUNCTION orgtree.foreground_time(value timestamptz, literal text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT coalesce(literal,to_char(value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'')
$fn$;

CREATE FUNCTION orgtree.foreground_request_time(resolved timestamptz, resolved_literal text,
                                               value timestamptz, literal text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT coalesce(resolved_literal,to_char(resolved AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),orgtree.foreground_time(value,literal))
$fn$;

CREATE FUNCTION orgtree.foreground_accumulate() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE n bigint; k text; previous bigint;
BEGIN
  IF TG_ARGV[0] !~ '^[a-z][a-z0-9_]*_rev$' OR TG_ARGV[1] NOT IN ('rows','flag') THEN
    RAISE EXCEPTION 'invalid foreground counter arguments';
  END IF;
  IF TG_OP = 'DELETE' THEN SELECT count(*) INTO n FROM old_rows;
  ELSE SELECT count(*) INTO n FROM new_rows; END IF;
  IF n = 0 THEN RETURN NULL; END IF;
  k := 'orgtree.pending_' || TG_ARGV[0];
  previous := coalesce(nullif(current_setting(k,true),''),'0')::bigint;
  PERFORM set_config(k, CASE WHEN TG_ARGV[1]='rows' THEN (previous+n)::text ELSE '1' END, true);
  RETURN NULL;
END
$fn$;

CREATE FUNCTION orgtree.foreground_flush() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE n bigint; k text; touched bigint;
BEGIN
  IF TG_ARGV[0] !~ '^[a-z][a-z0-9_]*_rev$' THEN RAISE EXCEPTION 'invalid foreground counter'; END IF;
  k := 'orgtree.pending_' || TG_ARGV[0];
  n := coalesce(nullif(current_setting(k,true),''),'0')::bigint;
  IF n=0 THEN RETURN NULL; END IF;
  PERFORM set_config(k,'0',true);
  EXECUTE format('UPDATE orgtree.org_revision SET %1$I=%1$I+$1 WHERE singleton',TG_ARGV[0]) USING n;
  GET DIAGNOSTICS touched=ROW_COUNT;
  IF touched<>1 THEN RAISE EXCEPTION 'foreground revision singleton missing'; END IF;
  RETURN NULL;
END
$fn$;

-- These are just the legacy catalog fields, over native columns. No JSON node
-- projection, cost/session data, parent closure or lineage cache is maintained.
-- extra carries codec-preserved ill-typed legacy fields; it is never searched.
CREATE FUNCTION orgtree.foreground_catalog(a orgtree.agents) RETURNS jsonb
LANGUAGE sql STABLE AS $fn$
 SELECT jsonb_build_array(a.name,a.ord,a.tombstone,a.lineage_born,a.extra::jsonb->'seat_id',
   a.parent_id,coalesce(a.parent,a.extra::jsonb->>'parent',''),
   coalesce(a.state,a.extra::jsonb->>'state','live'),
   coalesce(a.title,a.extra::jsonb->>'title',''),
   coalesce(a.model,a.extra::jsonb->>'model',''),coalesce(a.ui_order,0),
   coalesce(a.created_text,to_char(a.created AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),a.extra::jsonb->>'created',''),
   a.predecessor_id,coalesce(a.predecessor,a.extra::jsonb->>'predecessor',''),
   a.successor_id,coalesce(a.successor,a.extra::jsonb->>'successor',''),
   coalesce(to_jsonb(a.generation),CASE WHEN jsonb_typeof(a.extra::jsonb->'generation')='number'
      THEN a.extra::jsonb->'generation' END,'0'::jsonb),
   coalesce(to_jsonb(a.bearer_state),a.extra::jsonb->'bearer_state','null'::jsonb))
$fn$;

CREATE FUNCTION orgtree.foreground_catalog_accumulate() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE changed boolean;
BEGIN
  IF TG_OP='UPDATE' THEN
    SELECT EXISTS(SELECT 1 FROM new_rows n FULL JOIN old_rows o USING(id)
      WHERE orgtree.foreground_catalog(n::orgtree.agents) IS DISTINCT FROM
            orgtree.foreground_catalog(o::orgtree.agents)) INTO changed;
  ELSIF TG_OP='INSERT' THEN SELECT EXISTS(SELECT 1 FROM new_rows) INTO changed;
  ELSE SELECT EXISTS(SELECT 1 FROM old_rows) INTO changed; END IF;
  IF changed THEN PERFORM set_config('orgtree.pending_catalog_rev','1',true); END IF;
  RETURN NULL;
END
$fn$;

DO $install$
DECLARE t text; counter text; mode text; fn text;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
    WHERE s.nspname='orgtree' AND c.relkind='r' AND (
      c.relname IN ('agents','org_settings','org_sections','org_section_owners','org_extra',
        'org_dirs','org_tier_prices','org_tier_models','org_doc_migrations','net_state',
        'net_hubs','mail','delivery_batches','audience_grants','audience_requests',
        'watchdogs','watchdog_tombs','credit_requests','scope_requests','asks',
        'documents','org_inbox','user_inbox','work_items','work_scope_log') OR
      c.relname LIKE 'ask_%' OR c.relname LIKE 'scope_request_%' OR
      c.relname LIKE 'document_%' OR c.relname LIKE 'org_inbox_%' OR
      c.relname LIKE 'mail_attachments%' OR
      c.relname LIKE 'user_inbox_%' OR c.relname LIKE 'delivery_batch_%' OR
      c.relname LIKE 'work_item_%' OR c.relname LIKE 'watchdog_events')
  LOOP
    FOR counter,mode,fn IN
      SELECT 'node_rev','rows','foreground_accumulate' WHERE t='agents'
      UNION ALL SELECT 'catalog_rev','flag','foreground_catalog_accumulate' WHERE t='agents'
      UNION ALL SELECT 'view_rev','flag','foreground_accumulate' WHERE t<>'agents'
    LOOP
      EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON orgtree.%I REFERENCING NEW TABLE AS new_rows '
        'FOR EACH STATEMENT EXECUTE FUNCTION orgtree.%I(%L,%L)',counter||'_insert',t,fn,counter,mode);
      EXECUTE format('CREATE TRIGGER %I AFTER UPDATE ON orgtree.%I REFERENCING OLD TABLE AS old_rows '
        'NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.%I(%L,%L)',counter||'_update',t,fn,counter,mode);
      EXECUTE format('CREATE TRIGGER %I AFTER DELETE ON orgtree.%I REFERENCING OLD TABLE AS old_rows '
        'FOR EACH STATEMENT EXECUTE FUNCTION orgtree.%I(%L,%L)',counter||'_delete',t,fn,counter,mode);
      EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON orgtree.%I '
        'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orgtree.foreground_flush(%L)',
        counter||'_flush',t,counter);
    END LOOP;
  END LOOP;
END
$install$;

CREATE INDEX agents_foreground_live ON orgtree.agents(ord,name)
  WHERE coalesce(state,'live')<>'archived' AND NOT tombstone;
CREATE INDEX agents_foreground_retired ON orgtree.agents(parent_id,coalesce(ui_order,0),orgtree.foreground_time(created,created_text),ord,name)
  WHERE state='archived' AND NOT tombstone;
CREATE FUNCTION orgtree.agent_name_grams(value text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT coalesce(array_agg(DISTINCT substr(lower(value),p,width)),ARRAY[]::text[])
 FROM generate_series(1,3) width,
 LATERAL generate_series(1,length(value)-width+1) p
$fn$;
CREATE INDEX agents_foreground_search ON orgtree.agents USING gin(orgtree.agent_name_grams(name)) WHERE NOT tombstone;
CREATE INDEX agents_recent_turns_tail ON orgtree.agent_recent_turns(agent_id,pos DESC);
CREATE INDEX asks_foreground_node ON orgtree.asks(node,orgtree.foreground_request_time(resolved_at,resolved_at_text,at,at_text) DESC,ord);
CREATE INDEX asks_foreground_recent ON orgtree.asks(orgtree.foreground_request_time(resolved_at,resolved_at_text,at,at_text) DESC,ord DESC)
  WHERE coalesce(status,'') NOT IN ('open','pending');
CREATE INDEX credit_foreground_node ON orgtree.credit_requests(node,orgtree.foreground_time(at,at_text) DESC,ord);
CREATE INDEX scope_foreground_node ON orgtree.scope_requests(node,orgtree.foreground_request_time(resolved_at,resolved_at_text,at,at_text) DESC,ord);
CREATE INDEX documents_foreground_node ON orgtree.documents(node,ord DESC);
