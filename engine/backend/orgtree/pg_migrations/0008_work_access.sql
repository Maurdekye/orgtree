-- Access decisions are computed by Python's canonical ledger predicates.
-- SQL records dirty dependencies and makes unrefreshed reads fail closed.
CREATE FUNCTION public.orgtree_work_access_dirty() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
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
$fn$;

CREATE FUNCTION public.orgtree_install_work_access(p_org_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
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
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_install_work_access(bigint) FROM PUBLIC;

DO $migration$
DECLARE org record;
BEGIN
  FOR org IN SELECT org_id FROM public.orgs ORDER BY org_id LOOP
    EXECUTE format('LOCK TABLE org_%s.doc,org_%s.nodes,org_%s.log_l IN ACCESS EXCLUSIVE MODE',org.org_id,org.org_id,org.org_id);
    PERFORM public.orgtree_install_work_access(org.org_id);
  END LOOP;
END
$migration$;

ALTER FUNCTION public.orgtree_create_org_schema(bigint) RENAME TO orgtree_create_org_schema_before_work_access;
CREATE FUNCTION public.orgtree_create_org_schema(p_org_id bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE s text;
BEGIN
  s:=public.orgtree_create_org_schema_before_work_access(p_org_id);
  PERFORM public.orgtree_install_work_access(p_org_id);
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
