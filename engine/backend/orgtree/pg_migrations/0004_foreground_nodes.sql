-- Indexed node discovery for the foreground tree. The TEXT node remains the
-- source of truth. Derived rows become visible in the SAME commit, including
-- direct SQL/COPY writers and rollback. Nothing changes node row-CAS.

CREATE FUNCTION public.orgtree_foreground_meta(n jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
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
$fn$;

-- No pg_trgm installation dependency. Include one/two-character keys as well
-- as trigrams, so short substring searches do not silently become full scans.
-- Exact substring matching is still checked after the index candidate filter.
CREATE FUNCTION public.orgtree_id_grams(value text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT coalesce(array_agg(DISTINCT substr(lower(value), p, width)),ARRAY[]::text[])
 FROM generate_series(1,3) width,
      LATERAL generate_series(1,length(value)-width+1) p
$fn$;

CREATE FUNCTION public.orgtree_foreground_lineage(s text, changed text[])
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
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
$fn$;

CREATE FUNCTION public.orgtree_foreground_node_commit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
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
$fn$;

-- Tree headers and node cards need small windows of three otherwise growing
-- sections. Keep the source TEXT untouched; these derivative rows only select
-- the same windows that ledger.tree/node_ask expose.
CREATE FUNCTION public.orgtree_foreground_document(value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $fn$
 SELECT jsonb_build_object('id',value->'id','title',value->'title','at',value->'at',
                          'format',coalesce(nullif(value->>'format',''),'markdown'))
$fn$;

CREATE FUNCTION public.orgtree_foreground_doc(s text, k text, value text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
 IF k IN ('asks','credit_requests','scope_requests') THEN
   IF value IS NULL THEN
     EXECUTE format('DELETE FROM %I.foreground_asks WHERE sect=$1',s) USING k;
   ELSE
     EXECUTE format($sql$
       INSERT INTO %I.foreground_asks(sect,ord,node,status,stamp,val)
       SELECT $1,ord,v->>'node',v->>'status',coalesce(v->>'resolved_at',v->>'at',''),v::text
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
$fn$;

CREATE FUNCTION public.orgtree_foreground_doc_commit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
 IF TG_OP='UPDATE' AND (OLD.key,OLD.val) IS NOT DISTINCT FROM (NEW.key,NEW.val)
 THEN RETURN NULL; END IF;
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.key<>NEW.key) THEN
   PERFORM public.orgtree_foreground_doc(TG_TABLE_SCHEMA,OLD.key,NULL);
 END IF;
 IF TG_OP<>'DELETE' THEN
   PERFORM public.orgtree_foreground_doc(TG_TABLE_SCHEMA,NEW.key,NEW.val);
 END IF;
 RETURN NULL;
END
$fn$;

CREATE FUNCTION public.orgtree_foreground_log_commit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE s text:=TG_TABLE_SCHEMA; os text; ns text; oo text; no text; ov jsonb; nv jsonb;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.sect,OLD.seq,OLD.val) IS NOT DISTINCT FROM (NEW.sect,NEW.seq,NEW.val)
 THEN RETURN NULL; END IF;
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
$fn$;

CREATE FUNCTION public.orgtree_install_foreground_index(p_org_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
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
   'retired_axis_count bigint NOT NULL,cost numeric NOT NULL,cost_unknown bigint NOT NULL)',s);
 EXECUTE format('INSERT INTO %I.node_index(id,ord,meta) '
   'SELECT id,ord,public.orgtree_foreground_meta(val::jsonb) FROM %I.nodes',s,s);
 EXECUTE format('INSERT INTO %I.foreground_meta SELECT 1,0,0,count(*), '
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
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_install_foreground_index(bigint) FROM PUBLIC;

DO $migration$
DECLARE org record;
BEGIN
 FOR org IN SELECT org_id FROM public.orgs ORDER BY org_id LOOP
   EXECUTE format('LOCK TABLE org_%s.nodes,org_%s.doc,org_%s.log_l IN ACCESS EXCLUSIVE MODE',
                  org.org_id,org.org_id,org.org_id);
   PERFORM public.orgtree_install_foreground_index(org.org_id);
 END LOOP;
END
$migration$;

-- Preserve the existing table/grant creator and extend future bootstraps.
ALTER FUNCTION public.orgtree_create_org_schema(bigint) RENAME TO orgtree_create_org_schema_v3;
CREATE FUNCTION public.orgtree_create_org_schema(p_org_id bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE s text;
BEGIN
 s:=public.orgtree_create_org_schema_v3(p_org_id);
 PERFORM public.orgtree_install_foreground_index(p_org_id);
 RETURN s;
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_create_org_schema(bigint) FROM PUBLIC;
DO $grants$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='orgtree_runtime') THEN
   REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_v3(bigint) FROM orgtree_runtime;
   GRANT EXECUTE ON FUNCTION public.orgtree_create_org_schema(bigint) TO orgtree_runtime;
 END IF;
END
$grants$;
