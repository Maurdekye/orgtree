-- Test-only snapshot of queue-sol O1 graph foundation, exact 495b225.
-- Installation here does not install the O1 product migration or aggregates.
-- Native parent paths. Private migration: aggregate maintenance follows here.
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
