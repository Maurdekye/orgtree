-- A2a: typed policy/order support and the docket-only transaction counter.
-- No released build has written an org database. Older rehearsal databases
-- must be re-converted; never serve rows with uncomputed policy headers.
DO $guard$
BEGIN
 IF EXISTS (SELECT 1 FROM orgtree.work_items) THEN
   RAISE EXCEPTION 'converted before 0007: re-convert it from its legacy data';
 END IF;
END
$guard$;
ALTER TABLE orgtree.org_revision ADD COLUMN docket_rev bigint NOT NULL DEFAULT 0;

CREATE FUNCTION orgtree.docket_truth(v json) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT CASE json_typeof(v)
   WHEN 'object' THEN v::text !~ '^\s*\{\s*\}\s*$'
   WHEN 'array' THEN json_array_length(v)>0
   WHEN 'string' THEN v::text<>'""'
   WHEN 'number' THEN v::text::numeric<>0
   WHEN 'boolean' THEN v::text='true' ELSE false END
$fn$;

-- Retained unknown fields and a legacy inline scope archive remain detail-only.
-- Project these fallbacks at writes, so hot reads do not parse their authored text.
-- PostgreSQL's json lookup decodes every string while walking an object. Mask
-- escapes it cannot represent as text, then restore the exact JSON result.
CREATE FUNCTION orgtree.docket_safe(v json, OUT value json, OUT marker text)
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE encoded text := v::text;
BEGIN
 marker := '__orgtree_docket_escape__';
 IF v IS NULL THEN RETURN; END IF;
 WHILE strpos(encoded,marker)>0 LOOP marker := marker || '_'; END LOOP;
 encoded := regexp_replace(encoded,
   $pattern$(?<!\\)((?:\\\\)*)\\(u0000|u[dD][89aAbBcCdDeEfF][0-9a-fA-F]{2})$pattern$,
   $replacement$\1$replacement$ || marker || $replacement$\2$replacement$,'g');
 value := encoded::json;
END
$fn$;
CREATE FUNCTION orgtree.docket_restore(v json, marker text) RETURNS json
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT regexp_replace(v::text,
   marker || '(u0000|u[dD][89aAbBcCdDeEfF][0-9a-fA-F]{2})',
   $replacement$\\\1$replacement$,'g')::json
$fn$;
CREATE FUNCTION orgtree.docket_field(v json, VARIADIC path text[]) RETURNS json
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE safe json; marker text;
BEGIN
 SELECT s.value,s.marker INTO safe,marker FROM orgtree.docket_safe(v) s;
 RETURN orgtree.docket_restore(json_extract_path(safe,VARIADIC path),marker);
END
$fn$;
CREATE FUNCTION orgtree.docket_extra(v json, wanted text[]) RETURNS json
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE safe json; marker text; result json;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 SELECT s.value,s.marker INTO safe,marker FROM orgtree.docket_safe(v) s;
 SELECT json_object_agg(key,value) INTO result FROM json_each(safe) WHERE key=ANY(wanted);
 RETURN orgtree.docket_restore(result,marker);
END
$fn$;
CREATE FUNCTION orgtree.docket_scope_meta(v json) RETURNS json
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE safe json; marker text; result json;
BEGIN
 SELECT s.value,s.marker INTO safe,marker FROM orgtree.docket_safe(v) s;
 result := json_build_object(
   'archive_count',CASE WHEN json_typeof(safe->'scope_archive')='array'
      THEN json_array_length(safe->'scope_archive') ELSE 0 END,
   'first',json_build_object('seq',(safe->'scope_archive'->0)->'seq','at',(safe->'scope_archive'->0)->'at'),
   'last',json_build_object('seq',(safe->'scope_archive'->(-1))->'seq','at',(safe->'scope_archive'->(-1))->'at'),
   'inline_count',CASE WHEN json_typeof(safe->'scope')='array' THEN json_array_length(safe->'scope') END);
 RETURN orgtree.docket_restore(result,marker);
END
$fn$;
ALTER TABLE orgtree.work_items
 ADD COLUMN docket_policy_extra json GENERATED ALWAYS AS (orgtree.docket_extra(extra,ARRAY[
   'slug','rev','kind','title','status','owner','reviewer','created_by','participants','at',
   'updated_at','docket_at','archived_at','manual_attention','manual_attention_rev','parent','superseded_by'])) STORED,
 ADD COLUMN docket_list_extra json GENERATED ALWAYS AS (orgtree.docket_extra(extra,ARRAY[
   'slug','rev','kind','title','objective','status','blocked_reason','waiting_reason','dropped_reason',
   'owner','reviewer','created_by','last_updater','participants','at','updated_at','docket_at','status_at',
   'archived_at','done_so_far','working_on_next','manual_attention','dependencies','superseded_by','parent',
   'post_completion','scope_seq','scope_guard','scope_logged','scope_rolled','scope_frozen','legacy_status'])) STORED,
 ADD COLUMN docket_scope_meta json GENERATED ALWAYS AS (orgtree.docket_scope_meta(extra)) STORED;

-- SQL keys have only a real agent name as input. Python writes the same key
-- for arbitrary retained docket text, including unsupported PostgreSQL text.
CREATE FUNCTION orgtree.docket_key(v text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT coalesce(string_agg(lpad(to_hex(ascii(substr(v,n,1))),6,'0'),'' ORDER BY n),'')
 FROM generate_series(1,length(v)) n
$fn$;

ALTER TABLE orgtree.work_items
 ADD COLUMN docket_manual boolean NOT NULL,
 ADD COLUMN docket_order text NOT NULL,
 ADD COLUMN docket_deadline double precision,
 ADD COLUMN docket_owner_key text,
 ADD COLUMN docket_creator_key text,
 ADD COLUMN docket_reviewer_key text,
 ADD COLUMN docket_anchor_key text;
CREATE INDEX docket_hot_order ON orgtree.work_items(docket_order COLLATE "C" DESC,slug COLLATE "C" DESC,id)
 WHERE list_key='active';
CREATE INDEX docket_manual ON orgtree.work_items(id) WHERE docket_manual;
CREATE INDEX docket_deadlines ON orgtree.work_items(docket_deadline) WHERE list_key='active';
CREATE INDEX docket_archive_order ON orgtree.work_items(docket_order COLLATE "C" DESC,slug COLLATE "C" DESC,id);
CREATE INDEX docket_owner_ids ON orgtree.work_items(docket_owner_key,id);
CREATE INDEX docket_creator_ids ON orgtree.work_items(docket_creator_key,id);
CREATE INDEX docket_reviewer_ids ON orgtree.work_items(docket_reviewer_key,id);
CREATE INDEX docket_anchor_ids ON orgtree.work_items(docket_anchor_key,id);
CREATE INDEX docket_agent_names ON orgtree.agents(orgtree.docket_key(name)) WHERE NOT tombstone;
CREATE INDEX docket_archived_ids ON orgtree.work_items(id) WHERE list_key='archive';
CREATE INDEX docket_status_history ON orgtree.work_item_history(item_id,pos DESC)
 WHERE kind IS DISTINCT FROM 'folded' AND (op IN ('accept','reopen','supersede')
   OR (op='update' AND json_typeof(changes)='object' AND changes->'status' IS NOT NULL)
   OR (op='dismiss_attention' AND coalesce("from"::text,'null')<>'"blocked"'))
   AND (at IS NOT NULL OR orgtree.docket_truth(extra->'at'));

-- An ask's per-tab link is authoritative, even if an old roll-up disagrees.
-- Parse the shapeless tab payload only at writes, never in a hot count/query.
CREATE TABLE orgtree.docket_question_links(
 ask_id bigint NOT NULL REFERENCES orgtree.asks(id) ON DELETE CASCADE,
 item_slug text NOT NULL, PRIMARY KEY(ask_id,item_slug));
CREATE INDEX docket_questions_item ON orgtree.docket_question_links(item_slug,ask_id);
CREATE FUNCTION orgtree.docket_questions() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
BEGIN
 DELETE FROM orgtree.docket_question_links WHERE ask_id=NEW.id;
 IF NEW.status='open' AND json_typeof(NEW.questions)='array' THEN
   INSERT INTO orgtree.docket_question_links(ask_id,item_slug)
   SELECT DISTINCT NEW.id,q->>'work_item' FROM json_array_elements(NEW.questions) q
     WHERE json_typeof(q->'work_item')='string' ON CONFLICT DO NOTHING;
 END IF;
 RETURN NULL;
END
$fn$;
CREATE TRIGGER docket_questions AFTER INSERT OR UPDATE ON orgtree.asks
 FOR EACH ROW EXECUTE FUNCTION orgtree.docket_questions();
INSERT INTO orgtree.docket_question_links(ask_id,item_slug)
 SELECT DISTINCT a.id,q->>'work_item' FROM orgtree.asks a
 CROSS JOIN LATERAL json_array_elements(CASE WHEN json_typeof(a.questions)='array'
   THEN a.questions ELSE '[]'::json END) q
 WHERE a.status='open' AND json_typeof(q->'work_item')='string';

DO $install$
DECLARE t text;
BEGIN
 FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
   WHERE s.nspname='orgtree' AND c.relkind='r' AND
   (c.relname='work_items' OR c.relname LIKE 'work_item_%' OR
    c.relname IN ('work_scope_log','asks','docket_question_links'))
 LOOP
   EXECUTE format('CREATE TRIGGER docket_add AFTER INSERT ON orgtree.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.foreground_accumulate(''docket_rev'',''flag'')',t);
   EXECUTE format('CREATE TRIGGER docket_change AFTER UPDATE ON orgtree.%I REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.foreground_accumulate(''docket_rev'',''flag'')',t);
   EXECUTE format('CREATE TRIGGER docket_remove AFTER DELETE ON orgtree.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.foreground_accumulate(''docket_rev'',''flag'')',t);
   EXECUTE format('CREATE CONSTRAINT TRIGGER docket_flush AFTER INSERT OR UPDATE OR DELETE ON orgtree.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orgtree.foreground_flush(''docket_rev'')',t);
 END LOOP;
END
$install$;

-- This table is created after 0006 installs the shared-source hooks. Its own
-- writes must re-defer the internal flush after a caller forces FK checks.
CREATE TRIGGER foreground_defer BEFORE INSERT OR UPDATE OR DELETE
 ON orgtree.docket_question_links FOR EACH STATEMENT EXECUTE FUNCTION orgtree.foreground_defer();
