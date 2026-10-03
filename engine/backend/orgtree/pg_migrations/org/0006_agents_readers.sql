-- A1: native foreground stamps. Statement triggers collect transaction-local
-- deltas; deferred triggers lock the singleton only after the writer's rows.
ALTER TABLE orgtree.org_revision
  ADD COLUMN node_rev bigint NOT NULL DEFAULT 0,
  ADD COLUMN catalog_rev bigint NOT NULL DEFAULT 0,
  ADD COLUMN view_rev bigint NOT NULL DEFAULT 0,
  ADD COLUMN node_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN retired_axis_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN cost numeric NOT NULL DEFAULT 0,
  ADD COLUMN cost_unknown bigint NOT NULL DEFAULT 0;

-- Presence metadata, not a second value projection. Unknown unrelated keys
-- must not turn every archived row into a rare correction candidate.
DO $flags$
DECLARE field text;
BEGIN
  FOREACH field IN ARRAY ARRAY['parent','predecessor','successor','state','ui_order',
    'created','generation','bearer_state','cost_usd','cost_usd_unknown']
  LOOP
    EXECUTE format('ALTER TABLE orgtree.agents ADD COLUMN %I boolean '
      'GENERATED ALWAYS AS ((extra -> %L) IS NOT NULL) STORED',field||'_misfit',field);
    EXECUTE format('CREATE INDEX %I ON orgtree.agents(id) WHERE NOT tombstone AND %I',
      'agents_'||field||'_misfit',field||'_misfit');
  END LOOP;
END
$flags$;
CREATE INDEX agents_name_all ON orgtree.agents(name,tombstone,id);
CREATE TABLE orgtree.foreground_parent_counts (
  parent_id bigint PRIMARY KEY,
  retired_children bigint NOT NULL DEFAULT 0
);

-- This table contains numeric aggregates only. The key is a stable agent id,
-- with 0 for a missing parent; empty-name parents merge at read time.
CREATE FUNCTION orgtree.foreground_parent_delta(parent bigint, amount bigint) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE pending jsonb; key text:=parent::text;
BEGIN
  IF amount=0 THEN RETURN; END IF;
  pending:=coalesce(nullif(current_setting('orgtree.pending_parents',true),''),'{}')::jsonb;
  pending:=jsonb_set(pending,ARRAY[key],to_jsonb(coalesce((pending->>key)::bigint,0)+amount));
  PERFORM set_config('orgtree.pending_parents',pending::text,true);
END
$fn$;

DO $requests$
DECLARE relation text; field text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['asks','credit_requests','scope_requests'] LOOP
    FOREACH field IN ARRAY ARRAY['node','status','at','resolved_at'] LOOP
      EXECUTE format('ALTER TABLE orgtree.%I ADD COLUMN %I boolean '
        'GENERATED ALWAYS AS ((extra -> %L) IS NOT NULL) STORED',relation,field||'_misfit',field);
    END LOOP;
    EXECUTE format('CREATE INDEX %I ON orgtree.%I(id) WHERE '
      'node_misfit OR status_misfit OR at_misfit OR resolved_at_misfit',relation||'_foreground_misfit',relation);
    EXECUTE format('CREATE INDEX %I ON orgtree.%I(node,ord) WHERE status IN (''open'',''pending'')',
      relation||'_foreground_open',relation);
  END LOOP;
END
$requests$;

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
  old_nodes bigint:=0; new_nodes bigint:=0; old_retired bigint:=0; new_retired bigint:=0;
  old_cost numeric:=0; new_cost numeric:=0; old_unknown bigint:=0; new_unknown bigint:=0;
  field text; amount numeric; renamed_retired bigint; parent_delta record;
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
  IF TG_ARGV[0]='node_rev' THEN
    IF TG_OP<>'DELETE' THEN
      SELECT count(*),count(*) FILTER (WHERE state='archived' AND
        (successor_id IS NULL OR successor_id IN (SELECT id FROM orgtree.agents WHERE name=''))),
        coalesce(sum(cost_usd),0),count(*) FILTER (WHERE cost_usd_unknown)
        INTO new_nodes,new_retired,new_cost,new_unknown FROM new_rows WHERE NOT tombstone;
      FOR parent_delta IN SELECT coalesce(parent_id,0) AS parent_id,count(*) AS amount
        FROM new_rows WHERE NOT tombstone AND state='archived' AND
          (successor_id IS NULL OR successor_id IN (SELECT id FROM orgtree.agents WHERE name=''))
        GROUP BY parent_id
      LOOP
        PERFORM orgtree.foreground_parent_delta(parent_delta.parent_id,parent_delta.amount);
      END LOOP;
    END IF;
    IF TG_OP<>'INSERT' THEN
      -- References in OLD name the old target even when this statement also
      -- renamed/deleted that target. A valid empty reference is an org axis.
      SELECT count(*),count(*) FILTER (WHERE state='archived' AND
        (successor_id IS NULL OR successor_id IN (
          SELECT id FROM old_rows WHERE name='' UNION ALL
          SELECT id FROM orgtree.agents WHERE name='' AND id NOT IN (SELECT id FROM old_rows)))),
        coalesce(sum(cost_usd),0),count(*) FILTER (WHERE cost_usd_unknown)
        INTO old_nodes,old_retired,old_cost,old_unknown FROM old_rows WHERE NOT tombstone;
      FOR parent_delta IN SELECT coalesce(parent_id,0) AS parent_id,-count(*) AS amount
        FROM old_rows WHERE NOT tombstone AND state='archived' AND
          (successor_id IS NULL OR successor_id IN (
            SELECT id FROM old_rows WHERE name='' UNION ALL
            SELECT id FROM orgtree.agents WHERE name='' AND id NOT IN (SELECT id FROM old_rows)))
        GROUP BY parent_id
      LOOP
        PERFORM orgtree.foreground_parent_delta(parent_delta.parent_id,parent_delta.amount);
      END LOOP;
    END IF;
    IF TG_OP='UPDATE' THEN
      IF EXISTS(SELECT 1 FROM old_rows o JOIN new_rows v USING(id)
          WHERE o.name IS DISTINCT FROM v.name AND (o.name='' OR v.name='')) THEN
      -- Only the exceptional empty-name boundary can change another row's
      -- typed axis without writing it. Probe incoming links by successor_id.
        SELECT count(*) FILTER (WHERE v.name='')-count(*) FILTER (WHERE o.name='')
          INTO renamed_retired FROM old_rows o JOIN new_rows v USING(id)
          JOIN orgtree.agents a ON a.successor_id=o.id
          WHERE o.name IS DISTINCT FROM v.name AND (o.name='' OR v.name='')
            AND NOT a.tombstone AND a.state='archived'
            AND a.id NOT IN (SELECT id FROM new_rows);
        new_retired:=new_retired+renamed_retired;
        FOR parent_delta IN
          SELECT coalesce(a.parent_id,0) AS parent_id,
            count(*) FILTER (WHERE v.name='')-count(*) FILTER (WHERE o.name='') AS amount
          FROM old_rows o JOIN new_rows v USING(id)
          JOIN orgtree.agents a ON a.successor_id=o.id
          WHERE o.name IS DISTINCT FROM v.name AND (o.name='' OR v.name='')
            AND NOT a.tombstone AND a.state='archived'
            AND a.id NOT IN (SELECT id FROM new_rows) GROUP BY a.parent_id
        LOOP
          PERFORM orgtree.foreground_parent_delta(parent_delta.parent_id,parent_delta.amount);
        END LOOP;
      END IF;
    END IF;
    FOR field,amount IN SELECT 'node_count',(new_nodes-old_nodes)::numeric
      UNION ALL SELECT 'retired_axis_count',(new_retired-old_retired)::numeric
      UNION ALL SELECT 'cost',new_cost-old_cost
      UNION ALL SELECT 'cost_unknown',(new_unknown-old_unknown)::numeric
    LOOP
      k:='orgtree.pending_'||field;
      PERFORM set_config(k,(coalesce(nullif(current_setting(k,true),''),'0')::numeric+amount)::text,true);
    END LOOP;
  END IF;
  RETURN NULL;
END
$fn$;

CREATE FUNCTION orgtree.foreground_flush() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE n bigint; k text; touched bigint; field text; parent_delta record;
BEGIN
  IF TG_ARGV[0] !~ '^[a-z][a-z0-9_]*_rev$' THEN RAISE EXCEPTION 'invalid foreground counter'; END IF;
  k := 'orgtree.pending_' || TG_ARGV[0];
  n := coalesce(nullif(current_setting(k,true),''),'0')::bigint;
  IF n=0 THEN RETURN NULL; END IF;
  PERFORM set_config(k,'0',true);
  IF TG_ARGV[0]='node_rev' THEN
    -- A save already owns this lock from on_save_commit. Every flush must
    -- therefore acquire it before parent keys, even on a standalone write.
    PERFORM 1 FROM orgtree.org_revision WHERE singleton FOR UPDATE;
    FOR parent_delta IN SELECT key::bigint AS parent_id,value::bigint AS amount
      FROM jsonb_each_text(coalesce(nullif(current_setting('orgtree.pending_parents',true),''),'{}')::jsonb)
      WHERE value::bigint<>0 ORDER BY key::bigint
    LOOP
      INSERT INTO orgtree.foreground_parent_counts AS counts(parent_id,retired_children)
        VALUES(parent_delta.parent_id,parent_delta.amount)
        ON CONFLICT(parent_id) DO UPDATE SET retired_children=counts.retired_children+EXCLUDED.retired_children;
    END LOOP;
    PERFORM set_config('orgtree.pending_parents','{}',true);
    UPDATE orgtree.org_revision SET node_rev=node_rev+n,
      node_count=node_count+coalesce(nullif(current_setting('orgtree.pending_node_count',true),''),'0')::bigint,
      retired_axis_count=retired_axis_count+coalesce(nullif(current_setting('orgtree.pending_retired_axis_count',true),''),'0')::bigint,
      cost=cost+coalesce(nullif(current_setting('orgtree.pending_cost',true),''),'0')::numeric,
      cost_unknown=cost_unknown+coalesce(nullif(current_setting('orgtree.pending_cost_unknown',true),''),'0')::bigint
      WHERE singleton;
  ELSE
    EXECUTE format('UPDATE orgtree.org_revision SET %1$I=%1$I+$1 WHERE singleton',TG_ARGV[0]) USING n;
  END IF;
  GET DIAGNOSTICS touched=ROW_COUNT;
  IF touched<>1 THEN RAISE EXCEPTION 'foreground revision singleton missing'; END IF;
  IF TG_ARGV[0]='node_rev' THEN
    FOREACH field IN ARRAY ARRAY['node_count','retired_axis_count','cost','cost_unknown'] LOOP
      PERFORM set_config('orgtree.pending_'||field,'0',true);
    END LOOP;
  END IF;
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
        'org_doc_migration_holders','org_doc_migration_healed','net_state_seen_ids',
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
CREATE INDEX agents_foreground_discovery ON orgtree.agents(coalesce(state,'live'),name COLLATE "C")
  WHERE NOT tombstone AND NOT state_misfit;
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
CREATE INDEX credit_requests_foreground_recent ON orgtree.credit_requests(orgtree.foreground_time(at,at_text) DESC,ord DESC)
  WHERE coalesce(status,'') NOT IN ('open','pending') AND coalesce(status,'')<>'withdrawn';
CREATE INDEX scope_requests_foreground_recent ON orgtree.scope_requests(orgtree.foreground_request_time(resolved_at,resolved_at_text,at,at_text) DESC,ord DESC)
  WHERE coalesce(status,'') NOT IN ('open','pending') AND coalesce(status,'')<>'withdrawn';
CREATE INDEX documents_foreground_node ON orgtree.documents(node,ord DESC);
