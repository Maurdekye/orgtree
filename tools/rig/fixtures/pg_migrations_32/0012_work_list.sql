-- Derived static list fields. Bodies and scope records remain authoritative.
CREATE FUNCTION public.orgtree_work_list_dirty() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE s text:=TG_TABLE_SCHEMA; old_id text; new_id text;
BEGIN
  IF TG_TABLE_NAME='work_index' THEN
    IF TG_OP<>'INSERT' THEN old_id:=OLD.slug; END IF;
    IF TG_OP<>'DELETE' THEN new_id:=NEW.slug; END IF;
  ELSIF TG_TABLE_NAME='log_d' THEN
    IF TG_OP<>'INSERT' AND OLD.sect='work_scope_log' THEN old_id:=OLD.owner; END IF;
    IF TG_OP<>'DELETE' AND NEW.sect='work_scope_log' THEN new_id:=NEW.owner; END IF;
    IF old_id IS NULL AND new_id IS NULL THEN RETURN NULL; END IF;
  ELSIF TG_TABLE_NAME='nodes' THEN
    IF TG_OP='UPDATE' AND OLD.id=NEW.id AND
       jsonb_build_array(OLD.val::jsonb->'state',OLD.val::jsonb->'generation',OLD.val::jsonb->'seat_id',OLD.val::jsonb->'parent')=
       jsonb_build_array(NEW.val::jsonb->'state',NEW.val::jsonb->'generation',NEW.val::jsonb->'seat_id',NEW.val::jsonb->'parent') THEN
      RETURN NULL;
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
$fn$;

CREATE FUNCTION public.orgtree_install_work_list(p_org_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
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
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_install_work_list(bigint) FROM PUBLIC;

DO $migration$
DECLARE org record; s text;
BEGIN
  FOR org IN SELECT org_id FROM public.orgs ORDER BY org_id LOOP
    s:='org_'||org.org_id;
    EXECUTE format('LOCK TABLE %I.doc,%I.nodes,%I.log_l,%I.log_d IN ACCESS EXCLUSIVE MODE',s,s,s,s);
    IF NOT public.orgtree_check_work_index(org.org_id) THEN
      RAISE EXCEPTION 'docket list migration reconciliation failed in %',s;
    END IF;
    PERFORM public.orgtree_install_work_list(org.org_id);
  END LOOP;
END
$migration$;

ALTER FUNCTION public.orgtree_create_org_schema(bigint) RENAME TO orgtree_create_org_schema_before_work_list;
CREATE FUNCTION public.orgtree_create_org_schema(p_org_id bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE s text;
BEGIN
  s:=public.orgtree_create_org_schema_before_work_list(p_org_id);
  PERFORM public.orgtree_install_work_list(p_org_id);
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
