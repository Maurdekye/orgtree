-- The foreground tree shows only a node's newest 8 `turns`, while a live node
-- carries hundreds (about 90% of what a foreground rebuild read). Trimming at
-- READ time (foreground_store, 9a6c7fe) moved that cost into a per-read jsonb
-- parse: about 0.13 s of a 0.16 s rebuild at N=100. This keeps the trimmed
-- node at WRITE time instead, in the same commit, including direct SQL
-- writers, so a read parses nothing.
--
-- It is independent of 0004 (its own table and trigger), so it holds whatever
-- order the two are applied in; foreground_store LEFT JOINs it and serves
-- nodes.val when there is no row.
--
-- A row exists only when there is something to trim (more than 8 turns) and
-- jsonb round-trips the text exactly: not for exponent numbers (1e+16 would
-- read back as an int) or negative zero. The pattern matches json.dumps
-- output, where a number follows : , or [; a false positive inside a string
-- only costs that node's trim. 8 is ledger.TREE_TURNS;
-- tests/test_pg_foreground_turns.py pins both.

CREATE FUNCTION public.orgtree_foreground_tree_val(v text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE j jsonb;
BEGIN
 IF v ~ '[:,\[]-?[0-9]+(\.[0-9]+)?[eE]|[:,\[]-0\.0[,}\]]' THEN RETURN NULL; END IF;
 j:=v::jsonb;
 IF jsonb_typeof(j->'turns')='array' AND jsonb_array_length(j->'turns')>8 THEN
   RETURN jsonb_set(j,'{turns}',jsonb_path_query_array(j,'$.turns[last - 7 to last]'))::text;
 END IF;
 RETURN NULL;
END
$fn$;

CREATE FUNCTION public.orgtree_foreground_tree_val_commit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
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
$fn$;

-- Idempotent: creates what is missing and (re)derives every row from nodes.
CREATE FUNCTION public.orgtree_install_tree_val(p_org_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
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
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_install_tree_val(bigint) FROM PUBLIC;

DO $migration$
DECLARE org record;
BEGIN
  FOR org IN SELECT org_id FROM public.orgs ORDER BY org_id LOOP
    EXECUTE format('LOCK TABLE org_%s.nodes IN ACCESS EXCLUSIVE MODE',org.org_id);
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
