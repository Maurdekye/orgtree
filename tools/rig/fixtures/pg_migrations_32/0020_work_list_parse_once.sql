-- The docket list's dirty trigger read each node row's JSON EIGHT times per
-- update: `OLD.val::jsonb` and `NEW.val::jsonb` were each parsed again for
-- every field compared (state, generation, seat_id, parent). Node rows run to
-- ~12 KB on the live org (60 KB at most), and a reshape rewrites many at once
-- — a seat swap re-points every child row, retired ones included; a move
-- re-parents the manager's whole lineage stack. Measured on a copy of the
-- live org (v3-moving-an-agent-takes-10-s-to-actually-regist, 2026-10-01):
-- 481 rows re-parented in one statement spent ~600 ms in this trigger's
-- statement, ~300 ms with each value parsed once. The decision is unchanged:
-- the same four fields compared the same way, the same statements after it.
CREATE OR REPLACE FUNCTION public.orgtree_work_list_dirty() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
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
$fn$;
