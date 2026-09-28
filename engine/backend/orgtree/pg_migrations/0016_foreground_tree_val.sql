-- The foreground tree shows only a node's newest 8 `turns`, while a live node
-- carries hundreds (about 90% of what a foreground rebuild read). Trimming at
-- READ time (foreground_store, 9a6c7fe) moved that cost into a per-read jsonb
-- parse: about 0.13 s of a 0.16 s rebuild at N=100. The node trigger already
-- parses every written val once, at COMMIT; it now also stores the trimmed
-- node in node_index.tree_val, so a read parses nothing.
--
-- tree_val is NULL, and the reader serves nodes.val unchanged, when there is
-- nothing to trim (8 turns or fewer) or when jsonb could not round-trip the
-- text exactly: exponent numbers (1e+16 would read back as an int) and
-- negative zero. The pattern matches json.dumps output, where a number
-- follows : , or [; a false positive inside a string only costs that node's
-- trim. 8 is ledger.TREE_TURNS; tests/test_pg_foreground_turns.py pins both.

CREATE FUNCTION public.orgtree_foreground_tree_val(v text, j jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT CASE
   WHEN v ~ '[:,\[]-?[0-9]+(\.[0-9]+)?[eE]|[:,\[]-0\.0[,}\]]' THEN NULL
   WHEN jsonb_typeof(j->'turns')='array' AND jsonb_array_length(j->'turns')>8
     THEN jsonb_set(j,'{turns}',jsonb_path_query_array(j,'$.turns[last - 7 to last]'))::text
   ELSE NULL END
$fn$;

-- 0004's function, unchanged except: NEW.val is parsed once, and the index
-- upsert also writes tree_val.
CREATE OR REPLACE FUNCTION public.orgtree_foreground_node_commit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE
 s text:=TG_TABLE_SCHEMA; oldm jsonb; newm jsonb; newj jsonb;
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
   new_id:=NEW.id; newj:=NEW.val::jsonb; newm:=public.orgtree_foreground_meta(newj);
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
   EXECUTE format('INSERT INTO %I.node_index(id,ord,meta,tree_val) VALUES($1,$2,$3,$4) '
     'ON CONFLICT(id) DO UPDATE SET ord=excluded.ord,meta=excluded.meta,tree_val=excluded.tree_val '
     'WHERE (node_index.ord,node_index.meta,node_index.tree_val) '
     'IS DISTINCT FROM (excluded.ord,excluded.meta,excluded.tree_val)',s)
     USING NEW.id,NEW.ord,newm,public.orgtree_foreground_tree_val(NEW.val,newj);
 END IF;
 IF lineage_changed THEN
   PERFORM public.orgtree_foreground_lineage(s,array_remove(ARRAY[old_id,new_id],NULL));
 END IF;
 RETURN NULL;
END
$fn$;

-- Idempotent: adds the column if missing and (re)derives every row from nodes.
CREATE FUNCTION public.orgtree_install_tree_val(p_org_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE s text:='org_'||p_org_id;
BEGIN
 EXECUTE format('ALTER TABLE %I.node_index ADD COLUMN IF NOT EXISTS tree_val text',s);
 EXECUTE format('UPDATE %I.node_index i SET tree_val=public.orgtree_foreground_tree_val(n.val,n.val::jsonb) '
   'FROM %I.nodes n WHERE n.id=i.id '
   'AND i.tree_val IS DISTINCT FROM public.orgtree_foreground_tree_val(n.val,n.val::jsonb)',s,s);
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_install_tree_val(bigint) FROM PUBLIC;

DO $migration$
DECLARE org record;
BEGIN
  FOR org IN SELECT org_id FROM public.orgs ORDER BY org_id LOOP
    EXECUTE format('LOCK TABLE org_%s.nodes,org_%s.node_index IN ACCESS EXCLUSIVE MODE',
                   org.org_id,org.org_id);
    PERFORM public.orgtree_install_tree_val(org.org_id);
  END LOOP;
END
$migration$;

ALTER FUNCTION public.orgtree_create_org_schema(bigint)
  RENAME TO orgtree_create_org_schema_before_tree_val;
CREATE FUNCTION public.orgtree_create_org_schema(p_org_id bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE s text;
BEGIN
  s:=public.orgtree_create_org_schema_before_tree_val(p_org_id);
  PERFORM public.orgtree_install_tree_val(p_org_id);
  RETURN s;
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_create_org_schema(bigint) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='orgtree_runtime') THEN
    REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_tree_val(bigint) FROM orgtree_runtime;
    GRANT EXECUTE ON FUNCTION public.orgtree_create_org_schema(bigint) TO orgtree_runtime;
  END IF;
END
$grant$;
