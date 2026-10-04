-- Native parent paths and eager ancestor-path aggregates.
-- Pending roots belong to PostgreSQL transaction/savepoint state, not Python.

CREATE FUNCTION orgtree.graph_collect_roots() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE roots jsonb;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT jsonb_agg(id ORDER BY id) INTO roots FROM new_rows;
  ELSIF TG_OP='UPDATE' THEN
    SELECT jsonb_agg(v.id ORDER BY v.id) INTO roots
      FROM old_rows o JOIN new_rows v USING(id)
      WHERE o.parent_id IS DISTINCT FROM v.parent_id;
  ELSE
    RETURN NULL;                    -- deleted roots cannot form a final cycle
  END IF;
  IF roots IS NULL THEN RETURN NULL; END IF;
  SELECT jsonb_agg(id ORDER BY id) INTO roots FROM (
    SELECT DISTINCT value::bigint AS id FROM jsonb_array_elements_text(
      coalesce(nullif(current_setting('orgtree.graph_roots',true),''),'[]')::jsonb || roots)
  ) changed;
  PERFORM set_config('orgtree.graph_roots',roots::text,true),
          set_config('orgtree.graph_pending','1',true);
  RETURN NULL;
END
$fn$;

CREATE FUNCTION orgtree.graph_assert_final_cycles() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE roots bigint[]; ids bigint[]; parents integer[]; colors integer[];
  n integer; i integer; current_node integer;
BEGIN
  IF coalesce(current_setting('orgtree.graph_pending',true),'')<>'1' THEN RETURN; END IF;
  SELECT coalesce(array_agg(value::bigint),'{}'::bigint[]) INTO roots
    FROM jsonb_array_elements_text(
      coalesce(nullif(current_setting('orgtree.graph_roots',true),''),'[]')::jsonb);
  -- UNION reads each shared ancestor vertex once and terminates on a cycle.
  -- Dense local arrays then color every vertex once, without a query per root
  -- or per edge. No row lock or org-table write is hidden in this assertion.
  WITH RECURSIVE reached(id,parent_id) AS (
    SELECT id,parent_id FROM orgtree.agents WHERE id=ANY(roots)
    UNION
    SELECT a.id,a.parent_id FROM orgtree.agents a JOIN reached r ON a.id=r.parent_id
  ), dense AS MATERIALIZED (
    SELECT id,parent_id,row_number() OVER (ORDER BY id)::integer AS position FROM reached
  )
  SELECT array_agg(d.id ORDER BY d.position),
         array_agg(coalesce(p.position,0) ORDER BY d.position)
    INTO ids,parents FROM dense d LEFT JOIN dense p ON p.id=d.parent_id;
  n:=coalesce(cardinality(ids),0);
  colors:=array_fill(0,ARRAY[n]);
  FOR i IN 1..n LOOP
    IF colors[i]<>0 THEN CONTINUE; END IF;
    current_node:=i;
    WHILE current_node<>0 AND colors[current_node]=0 LOOP
      colors[current_node]:=1;
      current_node:=parents[current_node];
    END LOOP;
    IF current_node<>0 AND colors[current_node]=1 THEN
      RAISE EXCEPTION 'agent parent cycle at physical id %',ids[current_node]
        USING ERRCODE='23514';
    END IF;
    current_node:=i;
    WHILE current_node<>0 AND colors[current_node]=1 LOOP
      colors[current_node]:=2;
      current_node:=parents[current_node];
    END LOOP;
  END LOOP;
  PERFORM set_config('orgtree.graph_roots','[]',true),
          set_config('orgtree.graph_pending','0',true);
END
$fn$;

CREATE FUNCTION orgtree.graph_final_flush() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
BEGIN
  IF coalesce(current_setting('orgtree.graph_pending',true),'')='1' THEN
    -- Raw/bulk writers have no Python save callback. This takes the existing
    -- last tier, without allocating a second revision or forcing any check.
    PERFORM 1 FROM orgtree.org_revision WHERE singleton FOR UPDATE;
    PERFORM orgtree.graph_assert_final_cycles();
  END IF;
  RETURN NULL;
END
$fn$;

CREATE FUNCTION orgtree.graph_defer() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
BEGIN
  -- A caller may have checked constraints before this statement. Re-arm ours
  -- before row events, because transition roots are collected after statement.
  SET CONSTRAINTS orgtree.graph_final_guard DEFERRED;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER graph_roots_insert AFTER INSERT ON orgtree.agents
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION orgtree.graph_collect_roots();
CREATE TRIGGER graph_roots_update AFTER UPDATE ON orgtree.agents
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION orgtree.graph_collect_roots();
CREATE CONSTRAINT TRIGGER graph_final_guard AFTER INSERT OR UPDATE OR DELETE ON orgtree.agents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orgtree.graph_final_flush();
CREATE TRIGGER graph_defer BEFORE INSERT OR UPDATE OR DELETE ON orgtree.agents
  FOR EACH STATEMENT EXECUTE FUNCTION orgtree.graph_defer();

-- Eager aggregate section
-- Eager aggregates have one authority: agents.parent_id. No descendant writes.

CREATE TABLE orgtree.agent_subtree_stats (
  agent_id bigint PRIMARY KEY REFERENCES orgtree.agents(id) ON DELETE CASCADE,
  parent_agent_id bigint,
  descendants bigint NOT NULL DEFAULT 0 CHECK (descendants>=0),
  height integer NOT NULL DEFAULT 0 CHECK (height>=-1),
  org_children_count bigint NOT NULL DEFAULT 0 CHECK (org_children_count>=0)
);
CREATE INDEX agent_subtree_tallest
  ON orgtree.agent_subtree_stats(parent_agent_id,height DESC,agent_id);

-- Only the transition header is copied. Configured payload and child rows stay put.
CREATE TYPE orgtree.graph_image AS (
  id bigint, parent_id bigint, visible boolean, counted boolean
);

CREATE FUNCTION orgtree.graph_json_truthy(value json) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
BEGIN
  IF value IS NULL THEN RETURN false; END IF;
  CASE json_typeof(value)
    WHEN 'null' THEN RETURN false;
    WHEN 'boolean' THEN RETURN value::text='true';
    WHEN 'number' THEN RETURN value::text::numeric<>0;
    WHEN 'string' THEN RETURN value::text<>'""';
    WHEN 'array' THEN RETURN json_array_length(value)<>0;
    WHEN 'object' THEN RETURN value::text !~ '^\s*\{\s*\}\s*$';
    ELSE RAISE EXCEPTION 'unknown JSON kind';
  END CASE;
END
$fn$;

CREATE FUNCTION orgtree.graph_child_counted(a orgtree.agents, names jsonb DEFAULT '{}')
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,orgtree AS $fn$
DECLARE succeeded boolean;
BEGIN
  IF a.tombstone THEN RETURN false; END IF;
  IF a.state IS DISTINCT FROM 'archived' OR a.state_misfit THEN RETURN true; END IF;
  IF a.successor_misfit THEN
    succeeded:=orgtree.graph_json_truthy(a.extra->'successor');
  ELSIF names ? a.successor_id::text THEN
    succeeded:=(names->>a.successor_id::text)<>'';
  ELSE
    SELECT name<>'' INTO succeeded FROM orgtree.agents WHERE id=a.successor_id;
    succeeded:=coalesce(succeeded,false);
  END IF;
  RETURN NOT succeeded;
END
$fn$;

CREATE FUNCTION orgtree.graph_path_ids(images orgtree.graph_image[]) RETURNS bigint[]
LANGUAGE sql STABLE SET search_path=pg_catalog,orgtree AS $fn$
  WITH RECURSIVE old_image AS MATERIALIZED (SELECT * FROM unnest(images)),
  paths(id) AS (
    SELECT id FROM old_image
    UNION
    SELECT p.parent_id FROM paths r
      LEFT JOIN old_image o ON o.id=r.id
      LEFT JOIN orgtree.agents a ON a.id=r.id
      CROSS JOIN LATERAL unnest(ARRAY[o.parent_id,a.parent_id]) p(parent_id)
      WHERE p.parent_id IS NOT NULL
  ) SELECT coalesce(array_agg(id ORDER BY id),'{}'::bigint[]) FROM paths
$fn$;

CREATE FUNCTION orgtree.graph_apply(old_image orgtree.graph_image[],
                                   new_image orgtree.graph_image[]) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE paths bigint[]; refreshed bigint[]; native_plan jsonb;
  ids bigint[]; parents integer[]; old_parents integer[];
  present boolean[]; visible boolean[]; was_visible boolean[]; removed boolean[];
  sizes bigint[]; deltas bigint[]; child_deltas bigint[];
  old_heights integer[]; heights integer[]; height_dirty boolean[];
  degrees integer[]; old_degrees integer[]; queue integer[]; ready integer[];
  n integer; i integer; p integer; processed integer:=0; old_processed integer:=0;
  pos integer; old_p integer; new_p integer;
  old_count boolean; new_count boolean; inserting boolean;
BEGIN
  IF cardinality(old_image)=0 AND cardinality(new_image)=0 THEN RETURN; END IF;
  paths:=orgtree.graph_path_ids(old_image||new_image);
  native_plan:=nullif(current_setting('orgtree.graph_plan',true),'')::jsonb;
  IF native_plan IS NOT NULL AND NOT (native_plan->>'whole')::boolean AND EXISTS (
    SELECT 1 FROM unnest(paths) p(id)
    WHERE NOT (native_plan->'stats') @> jsonb_build_array(p.id)
      AND EXISTS(SELECT 1 FROM orgtree.agent_subtree_stats s WHERE s.agent_id=p.id)
  ) THEN
    RAISE EXCEPTION 'native graph path was not prelocked' USING ERRCODE='40001';
  END IF;
  -- New rows have no pre-existing lock to take. Only INSERT images may create
  -- caches; a missing UPDATE cache is a reconcile failure, never a silent repair.
  INSERT INTO orgtree.agent_subtree_stats(agent_id,parent_agent_id,height)
    SELECT v.id,v.parent_id,CASE WHEN v.visible THEN 0 ELSE -1 END
    FROM unnest(new_image) v WHERE NOT EXISTS(SELECT 1 FROM unnest(old_image) o WHERE o.id=v.id);
  PERFORM agent_id FROM orgtree.agent_subtree_stats WHERE agent_id=ANY(paths)
    ORDER BY agent_id FOR UPDATE;
  -- A raw writer can wait here. Its fresh path must fit the locks just taken;
  -- restarting is safe, acquiring an earlier-tier row after a wait is not.
  refreshed:=orgtree.graph_path_ids(old_image||new_image);
  IF refreshed IS DISTINCT FROM paths THEN
    RAISE EXCEPTION 'agent graph paths changed while acquiring stats locks' USING ERRCODE='40001';
  END IF;
  IF EXISTS(SELECT 1 FROM orgtree.agents a LEFT JOIN orgtree.agent_subtree_stats s ON s.agent_id=a.id
            WHERE a.id=ANY(paths) AND s.agent_id IS NULL) THEN
    RAISE EXCEPTION 'agent graph cache missing; reconciliation required' USING ERRCODE='23514';
  END IF;

  WITH dense AS MATERIALIZED (
    SELECT id,row_number() OVER (ORDER BY id)::integer AS position FROM unnest(paths) p(id)
  ), old_rows AS MATERIALIZED (SELECT * FROM unnest(old_image)),
  new_rows AS MATERIALIZED (SELECT * FROM unnest(new_image))
  SELECT array_agg(d.id ORDER BY d.position),
         array_agg(coalesce(p.position,0) ORDER BY d.position),
         array_agg(coalesce(op.position,0) ORDER BY d.position),
         array_agg(a.id IS NOT NULL ORDER BY d.position),
         array_agg(coalesce(NOT a.tombstone,false) ORDER BY d.position),
         array_agg(coalesce(o.visible,NOT a.tombstone,false) ORDER BY d.position),
         array_agg(a.id IS NULL ORDER BY d.position),
         array_agg(coalesce(s.descendants,0) ORDER BY d.position),
         array_agg(coalesce(s.height,0) ORDER BY d.position),
         array_agg(CASE WHEN a.id IS NOT NULL THEN coalesce(s.org_children_count,0) ELSE 0 END ORDER BY d.position)
    INTO ids,parents,old_parents,present,visible,was_visible,removed,sizes,old_heights,child_deltas
    FROM dense d LEFT JOIN orgtree.agents a ON a.id=d.id
    LEFT JOIN orgtree.agent_subtree_stats s ON s.agent_id=d.id
    LEFT JOIN old_rows o ON o.id=d.id LEFT JOIN new_rows v ON v.id=d.id
    LEFT JOIN dense p ON p.id=a.parent_id
    LEFT JOIN dense op ON op.id=CASE WHEN o.id IS NOT NULL THEN o.parent_id ELSE a.parent_id END;
  n:=cardinality(ids);
  deltas:=array_fill(0::bigint,ARRAY[n]);
  degrees:=array_fill(0,ARRAY[n]); old_degrees:=array_fill(0,ARRAY[n]);
  height_dirty:=array_fill(false,ARRAY[n]); heights:=old_heights;

  -- FK cascades already removed a deleted node's cache. Every surviving child
  -- would violate the immediate parent FK, so its OLD component is complete.
  FOR i IN 1..n LOOP
    IF removed[i] AND old_parents[i]<>0 AND removed[old_parents[i]] THEN
      old_degrees[old_parents[i]]:=old_degrees[old_parents[i]]+1;
    END IF;
  END LOOP;
  SELECT coalesce(array_agg(g.i),'{}'::integer[]) INTO queue FROM generate_series(1,n) g(i)
    WHERE removed[g.i] AND old_degrees[g.i]=0;
  WHILE cardinality(queue)>0 LOOP
    ready:='{}'::integer[];
    FOREACH i IN ARRAY queue LOOP
      old_processed:=old_processed+1; p:=old_parents[i];
      IF p<>0 AND removed[p] THEN
        IF was_visible[i] THEN sizes[p]:=sizes[p]+sizes[i]+1; END IF;
        old_degrees[p]:=old_degrees[p]-1;
        IF old_degrees[p]=0 THEN ready:=array_append(ready,p); END IF;
      END IF;
    END LOOP;
    queue:=ready;
  END LOOP;
  IF old_processed<>(SELECT count(*) FROM unnest(removed) v WHERE v) THEN
    RAISE EXCEPTION 'deleted OLD parent cycle' USING ERRCODE='23514';
  END IF;

  -- Lookup dense indices once in SQL. There is no array_position or ancestor
  -- query inside these loops, and no repeat traversal for shared path suffixes.
  FOR pos,old_p,new_p,old_count,new_count,inserting IN
    WITH dense AS (SELECT d.id,d.i FROM unnest(ids) WITH ORDINALITY d(id,i)),
    o AS (SELECT * FROM unnest(old_image)), v AS (SELECT * FROM unnest(new_image))
    SELECT d.i::integer,coalesce(op.i,0)::integer,coalesce(np.i,0)::integer,
      coalesce(o.counted,false),coalesce(v.counted,false),o.id IS NULL
    FROM o FULL JOIN v USING(id) JOIN dense d ON d.id=coalesce(v.id,o.id)
      LEFT JOIN dense op ON op.id=o.parent_id LEFT JOIN dense np ON np.id=v.parent_id
  LOOP
    IF old_p<>0 THEN
      IF was_visible[pos] THEN deltas[old_p]:=deltas[old_p]-sizes[pos]-1; END IF;
      child_deltas[old_p]:=child_deltas[old_p]-CASE WHEN old_count THEN 1 ELSE 0 END;
      height_dirty[old_p]:=true;
    END IF;
    IF new_p<>0 THEN
      IF visible[pos] THEN deltas[new_p]:=deltas[new_p]+sizes[pos]+1; END IF;
      child_deltas[new_p]:=child_deltas[new_p]+CASE WHEN new_count THEN 1 ELSE 0 END;
      height_dirty[new_p]:=true;
    END IF;
    IF was_visible[pos] IS DISTINCT FROM visible[pos] OR removed[pos]
       OR inserting THEN
      height_dirty[pos]:=true;
    END IF;
  END LOOP;

  -- Publish the changed edge copies before any indexed height probe. An OLD
  -- parent may be ready in the same wave as its moved child, and must not see
  -- that child through yesterday's edge in the tallest-child index.
  UPDATE orgtree.agent_subtree_stats s SET parent_agent_id=a.parent_id
    FROM orgtree.agents a WHERE a.id=ANY(paths) AND s.agent_id=a.id
      AND s.parent_agent_id IS DISTINCT FROM a.parent_id;

  FOR i IN 1..n LOOP
    IF present[i] AND parents[i]<>0 THEN degrees[parents[i]]:=degrees[parents[i]]+1; END IF;
  END LOOP;
  SELECT coalesce(array_agg(g.i),'{}'::integer[]) INTO queue FROM generate_series(1,n) g(i)
    WHERE present[g.i] AND degrees[g.i]=0;
  WHILE cardinality(queue)>0 LOOP
    -- Child levels are written before their parents' single indexed maximum.
    SELECT array_agg(CASE WHEN NOT visible[g.i] THEN -1
                    WHEN height_dirty[g.i] THEN coalesce(c.height+1,0)
                    ELSE heights[g.i] END ORDER BY g.ord)
      INTO ready FROM unnest(queue) WITH ORDINALITY g(i,ord)
      LEFT JOIN LATERAL (
        SELECT s.height FROM orgtree.agent_subtree_stats s
        WHERE s.parent_agent_id=ids[g.i] AND s.height>=0 AND height_dirty[g.i]
        ORDER BY s.height DESC,s.agent_id LIMIT 1
      ) c ON true;
    FOR pos IN 1..cardinality(queue) LOOP heights[queue[pos]]:=ready[pos]; END LOOP;
    UPDATE orgtree.agent_subtree_stats s SET
      parent_agent_id=a.parent_id,descendants=sizes[g.i]+deltas[g.i],
      height=heights[g.i],org_children_count=child_deltas[g.i]
      FROM unnest(queue) g(i) JOIN orgtree.agents a ON a.id=ids[g.i]
      WHERE s.agent_id=a.id AND (s.parent_agent_id,s.descendants,s.height,s.org_children_count)
        IS DISTINCT FROM (a.parent_id,sizes[g.i]+deltas[g.i],heights[g.i],child_deltas[g.i]);
    ready:='{}'::integer[];
    FOREACH i IN ARRAY queue LOOP
      processed:=processed+1; p:=parents[i];
      IF p<>0 THEN
        IF visible[i] THEN deltas[p]:=deltas[p]+deltas[i]; END IF;
        IF heights[i] IS DISTINCT FROM old_heights[i] THEN height_dirty[p]:=true; END IF;
        degrees[p]:=degrees[p]-1;
        IF degrees[p]=0 THEN ready:=array_append(ready,p); END IF;
      END IF;
    END LOOP;
    queue:=ready;
  END LOOP;
  IF processed<>(SELECT count(*) FROM unnest(present) v WHERE v) THEN
    RAISE EXCEPTION 'agent parent cycle in eager aggregates' USING ERRCODE='23514';
  END IF;
END
$fn$;

CREATE FUNCTION orgtree.graph_maintain_stats() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE old_image orgtree.graph_image[]:='{}'; new_image orgtree.graph_image[]:='{}';
  old_names jsonb:='{}'; new_names jsonb:='{}';
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT coalesce(array_agg(ROW(id,parent_id,NOT tombstone,orgtree.graph_child_counted(v))::orgtree.graph_image),'{}')
      INTO new_image FROM new_rows v;
  ELSIF TG_OP='DELETE' THEN
    SELECT coalesce(jsonb_object_agg(id::text,name),'{}') INTO old_names FROM old_rows;
    SELECT coalesce(array_agg(ROW(id,parent_id,NOT tombstone,orgtree.graph_child_counted(o,old_names))::orgtree.graph_image),'{}')
      INTO old_image FROM old_rows o;
  ELSE
    SELECT coalesce(jsonb_object_agg(o.id::text,o.name),'{}'),coalesce(jsonb_object_agg(v.id::text,v.name),'{}')
      INTO old_names,new_names FROM old_rows o JOIN new_rows v USING(id)
      WHERE o.name IS DISTINCT FROM v.name AND (o.name='' OR v.name='');
    WITH images AS (
      SELECT ROW(o.id,o.parent_id,NOT o.tombstone,orgtree.graph_child_counted(o,old_names))::orgtree.graph_image AS o,
             ROW(v.id,v.parent_id,NOT v.tombstone,orgtree.graph_child_counted(v,new_names))::orgtree.graph_image AS v
        FROM old_rows o JOIN new_rows v USING(id)
        WHERE (o.parent_id,o.tombstone,o.state,o.successor_id,o.successor_misfit,
               CASE WHEN o.successor_misfit THEN o.extra::text END)
          IS DISTINCT FROM
          (v.parent_id,v.tombstone,v.state,v.successor_id,v.successor_misfit,
               CASE WHEN v.successor_misfit THEN v.extra::text END)
          OR o.successor_id IN (SELECT key::bigint FROM jsonb_each(old_names))
      UNION ALL
      SELECT ROW(a.id,a.parent_id,NOT a.tombstone,orgtree.graph_child_counted(a,old_names))::orgtree.graph_image,
             ROW(a.id,a.parent_id,NOT a.tombstone,orgtree.graph_child_counted(a,new_names))::orgtree.graph_image
        FROM orgtree.agents a WHERE a.successor_id IN (SELECT key::bigint FROM jsonb_each(old_names))
          AND NOT EXISTS(SELECT 1 FROM new_rows v WHERE v.id=a.id)
    ) SELECT coalesce(array_agg(o),'{}'),coalesce(array_agg(v),'{}')
      INTO old_image,new_image FROM images WHERE o IS DISTINCT FROM v;
  END IF;
  PERFORM orgtree.graph_apply(old_image,new_image);
  RETURN NULL;
END
$fn$;

-- Raw, converted and native writers all use these same eager statement hooks.
CREATE TRIGGER graph_stats_insert AFTER INSERT ON orgtree.agents
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.graph_maintain_stats();
CREATE TRIGGER graph_stats_update AFTER UPDATE ON orgtree.agents
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.graph_maintain_stats();
CREATE TRIGGER graph_stats_delete AFTER DELETE ON orgtree.agents
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.graph_maintain_stats();

CREATE FUNCTION orgtree.graph_verify_stats() RETURNS TABLE(agent_id bigint,issue text)
LANGUAGE sql STABLE SET search_path=pg_catalog,orgtree AS $fn$
  -- Deliberately independent, slower reference for backfill and diagnostics.
  WITH RECURSIVE ancestors(descendant,ancestor,distance,seen) AS (
    SELECT id,parent_id,1,ARRAY[id] FROM orgtree.agents WHERE NOT tombstone AND parent_id IS NOT NULL
    UNION ALL
    SELECT r.descendant,a.parent_id,r.distance+1,r.seen||a.id
      FROM ancestors r JOIN orgtree.agents a ON a.id=r.ancestor
      WHERE NOT a.tombstone AND a.parent_id IS NOT NULL AND NOT a.id=ANY(r.seen)
  ), reference AS (
    SELECT a.id,a.parent_id,count(r.descendant) AS descendants,
      CASE WHEN a.tombstone THEN -1 ELSE coalesce(max(r.distance),0) END AS height,
      (SELECT count(*) FROM orgtree.agents c WHERE c.parent_id=a.id AND orgtree.graph_child_counted(c)) AS children
      FROM orgtree.agents a LEFT JOIN ancestors r ON r.ancestor=a.id GROUP BY a.id
  ) SELECT coalesce(a.id,s.agent_id),CASE
      WHEN a.id IS NULL THEN 'extra cache' WHEN s.agent_id IS NULL THEN 'missing cache'
      WHEN a.parent_id IS DISTINCT FROM s.parent_agent_id THEN 'parent copy'
      WHEN a.descendants<>s.descendants THEN 'descendants'
      WHEN a.height<>s.height THEN 'height' ELSE 'org children' END
    FROM reference a FULL JOIN orgtree.agent_subtree_stats s ON s.agent_id=a.id
    WHERE a.id IS NULL OR s.agent_id IS NULL OR
      (a.parent_id,a.descendants,a.height,a.children) IS DISTINCT FROM
      (s.parent_agent_id,s.descendants,s.height,s.org_children_count)
$fn$;

DO $backfill$
DECLARE images orgtree.graph_image[];
BEGIN
  SELECT coalesce(array_agg(ROW(id,parent_id,NOT tombstone,orgtree.graph_child_counted(a))::orgtree.graph_image),'{}')
    INTO images FROM orgtree.agents a;
  PERFORM orgtree.graph_apply('{}',images);
  IF EXISTS(SELECT 1 FROM orgtree.graph_verify_stats()) THEN
    RAISE EXCEPTION 'agent graph backfill does not match reference' USING ERRCODE='23514';
  END IF;
END
$backfill$;
