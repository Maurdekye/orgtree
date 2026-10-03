-- Desktop archive totals must not recount retained history. Accumulation is
-- transaction-local: a rollback, including to a savepoint, discards its deltas.
CREATE TABLE orgtree.docket_counters (
 kind text PRIMARY KEY CHECK (kind IN ('archive')),
 n bigint NOT NULL CHECK (n >= 0)
);
INSERT INTO orgtree.docket_counters(kind,n)
 SELECT 'archive',count(*) FROM orgtree.work_items WHERE list_key='archive';

CREATE FUNCTION orgtree.docket_archive_accumulate() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE added bigint := 0; removed bigint := 0; previous bigint;
BEGIN
 IF TG_OP <> 'DELETE' THEN
   SELECT count(*) INTO added FROM new_rows WHERE list_key='archive';
 END IF;
 IF TG_OP <> 'INSERT' THEN
   SELECT count(*) INTO removed FROM old_rows WHERE list_key='archive';
 END IF;
 IF added=removed THEN RETURN NULL; END IF;
 previous := coalesce(nullif(current_setting('orgtree.pending_docket_archive',true),''),'0')::bigint;
 PERFORM set_config('orgtree.pending_docket_archive',(previous+added-removed)::text,true);
 RETURN NULL;
END
$fn$;

CREATE FUNCTION orgtree.docket_archive_flush() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE delta bigint;
BEGIN
 delta := coalesce(nullif(current_setting('orgtree.pending_docket_archive',true),''),'0')::bigint;
 IF delta=0 THEN RETURN NULL; END IF;
 PERFORM set_config('orgtree.pending_docket_archive','0',true);
 -- Same order as the other derived counters: revision first, then counter keys.
 PERFORM 1 FROM orgtree.org_revision WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'docket revision singleton missing'; END IF;
 UPDATE orgtree.docket_counters SET n=n+delta WHERE kind='archive';
 IF NOT FOUND THEN RAISE EXCEPTION 'docket archive counter missing'; END IF;
 RETURN NULL;
END
$fn$;

CREATE TRIGGER docket_archive_add AFTER INSERT ON orgtree.work_items
 REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
 EXECUTE FUNCTION orgtree.docket_archive_accumulate();
CREATE TRIGGER docket_archive_change AFTER UPDATE ON orgtree.work_items
 REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT
 EXECUTE FUNCTION orgtree.docket_archive_accumulate();
CREATE TRIGGER docket_archive_remove AFTER DELETE ON orgtree.work_items
 REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
 EXECUTE FUNCTION orgtree.docket_archive_accumulate();
CREATE CONSTRAINT TRIGGER docket_archive_flush AFTER INSERT OR UPDATE OR DELETE
 ON orgtree.work_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION orgtree.docket_archive_flush();
