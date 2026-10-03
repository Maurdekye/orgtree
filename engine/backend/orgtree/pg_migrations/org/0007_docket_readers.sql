-- A2a: typed policy/order support and the docket-only transaction counter.
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

CREATE FUNCTION orgtree.docket_stamp(v timestamptz, original text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT coalesce(original,to_char(v AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$fn$;

CREATE FUNCTION orgtree.docket_deadline(status text, stamp text) RETURNS double precision
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET timezone='UTC' AS $fn$
BEGIN
 IF status='dropped' THEN RETURN '-Infinity'::double precision; END IF;
 IF coalesce(status,'') NOT IN ('done','superseded') OR stamp IS NULL OR
    stamp !~ '^\d{4}-\d{2}-\d{2}([Tt ]|$)' THEN RETURN NULL; END IF;
 RETURN extract(epoch FROM stamp::timestamptz)::double precision+3600;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END
$fn$;

ALTER TABLE orgtree.work_items
 ADD COLUMN docket_manual boolean GENERATED ALWAYS AS (orgtree.docket_truth(manual_attention)) STORED,
 ADD COLUMN docket_order text GENERATED ALWAYS AS (coalesce(
   nullif(extra->>'docket_at',''),orgtree.docket_stamp(docket_at,docket_at_text),
   nullif(extra->>'updated_at',''),orgtree.docket_stamp(updated_at,updated_at_text),'')) STORED,
 ADD COLUMN docket_deadline double precision GENERATED ALWAYS AS (orgtree.docket_deadline(
   coalesce(status,extra->>'status'),coalesce(nullif(extra->>'docket_at',''),
   orgtree.docket_stamp(docket_at,docket_at_text),nullif(extra->>'updated_at',''),
   orgtree.docket_stamp(updated_at,updated_at_text)))) STORED;
CREATE INDEX docket_hot_order ON orgtree.work_items(docket_order COLLATE "C" DESC,slug COLLATE "C" DESC,id)
 WHERE list_key='active';
CREATE INDEX docket_manual ON orgtree.work_items(id) WHERE docket_manual;
CREATE INDEX docket_deadlines ON orgtree.work_items(docket_deadline) WHERE list_key='active';
CREATE INDEX docket_archive_order ON orgtree.work_items(docket_order COLLATE "C" DESC,slug COLLATE "C" DESC,id);
CREATE INDEX docket_owner_ids ON orgtree.work_items(owner_node,id);
CREATE INDEX docket_creator_ids ON orgtree.work_items(created_by_node,id);
CREATE INDEX docket_reviewer_ids ON orgtree.work_items(reviewer_node,id);
CREATE INDEX docket_anchor_ids ON orgtree.work_items(anchor_name,id);
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
