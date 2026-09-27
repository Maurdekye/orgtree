-- Derived archive bounds. The source log and its ordering fields are untouched.
-- Migration runs under the root migration lock; each org is reconciled atomically.
CREATE OR REPLACE FUNCTION public.orgtree_mail_ordinal(v text) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN json_typeof(v::json->'recv_seq') = 'number'
                   AND (v::json->>'recv_seq') ~ '^[1-9][0-9]*$'
              THEN (v::json->>'recv_seq')::numeric ELSE 0 END
$fn$;

CREATE OR REPLACE FUNCTION public.orgtree_mail_unknown(v text) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN json_typeof(v::json) IS DISTINCT FROM 'object' THEN 1
              WHEN v::json->'recv_seq' IS NOT NULL
                   AND public.orgtree_mail_ordinal(v) = 0 THEN 1 ELSE 0 END
$fn$;

CREATE OR REPLACE FUNCTION public.orgtree_reconcile_mail_owner(s text, recipient text)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE n bigint; bad bigint; high numeric; written bigint;
BEGIN
  EXECUTE format('SELECT count(*), coalesce(sum(public.orgtree_mail_unknown(val)),0), '
                 'coalesce(max(public.orgtree_mail_ordinal(val)),0) FROM %I.log_d '
                 'WHERE sect=''mail_log'' AND owner=$1',s)
    INTO n,bad,high USING recipient;
  EXECUTE format('INSERT INTO %I.mail_archive_bounds(owner,nrows,unknown_rows,assigned_max,version,format) '
                 'VALUES($1,$2,$3,$4,1,1) ON CONFLICT(owner) DO UPDATE SET '
                 'nrows=excluded.nrows,unknown_rows=excluded.unknown_rows,assigned_max=excluded.assigned_max,'
                 'version=mail_archive_bounds.version+1,format=1 RETURNING nrows',s)
    INTO written USING recipient,n,bad,high;
  IF written <> n THEN RAISE EXCEPTION 'mail archive count mismatch in % for %',s,recipient; END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION public.orgtree_track_mail_archive() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE recipient text; old_n bigint; old_bad bigint; old_max numeric; found_format integer;
        delta_n bigint; delta_bad bigint; added numeric; removed numeric; high numeric;
BEGIN
  -- A mailbox advisory lock also covers the first row, absent from the summary.
  -- Initialize BEFORE mutation, count actual changes AFTER mutation. COPY can
  -- expose a whole statement to AFTER row triggers; a rebuild there would
  -- double-count. Counting BEFORE would count ON CONFLICT DO NOTHING as a row.
  FOR recipient IN
    SELECT DISTINCT x FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' AND OLD.sect='mail_log' THEN OLD.owner END,
      CASE WHEN TG_OP <> 'DELETE' AND NEW.sect='mail_log' THEN NEW.owner END]) x
    WHERE x IS NOT NULL ORDER BY x
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA),hashtext('mail-bound:'||recipient));
    EXECUTE format('SELECT nrows,unknown_rows,assigned_max,format FROM %I.mail_archive_bounds '
                   'WHERE owner=$1 FOR UPDATE',TG_TABLE_SCHEMA)
      INTO old_n,old_bad,old_max,found_format USING recipient;
    IF old_n IS NULL OR found_format <> 1 THEN
      IF TG_WHEN <> 'BEFORE' THEN RAISE EXCEPTION 'mail archive bound lost during mutation'; END IF;
      PERFORM public.orgtree_reconcile_mail_owner(TG_TABLE_SCHEMA,recipient);
      EXECUTE format('SELECT nrows,unknown_rows,assigned_max FROM %I.mail_archive_bounds '
                     'WHERE owner=$1',TG_TABLE_SCHEMA)
        INTO old_n,old_bad,old_max USING recipient;
    END IF;
    IF TG_WHEN='BEFORE' THEN CONTINUE; END IF;
    delta_n:=0; delta_bad:=0; added:=0; removed:=0;
    IF TG_OP <> 'INSERT' AND OLD.sect='mail_log' AND OLD.owner=recipient THEN
      delta_n:=delta_n-1; delta_bad:=delta_bad-public.orgtree_mail_unknown(OLD.val);
      removed:=public.orgtree_mail_ordinal(OLD.val);
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.sect='mail_log' AND NEW.owner=recipient THEN
      delta_n:=delta_n+1; delta_bad:=delta_bad+public.orgtree_mail_unknown(NEW.val);
      added:=public.orgtree_mail_ordinal(NEW.val);
    END IF;
    high:=greatest(old_max,added);
    IF removed >= high AND removed > 0 THEN
      EXECUTE format('SELECT public.orgtree_mail_ordinal(val) FROM %I.log_d '
                     'WHERE sect=''mail_log'' AND owner=$1 AND seq<>$2 '
                     'ORDER BY public.orgtree_mail_ordinal(val) DESC LIMIT 1',TG_TABLE_SCHEMA)
        INTO high USING recipient,OLD.seq;
      high:=greatest(coalesce(high,0),added);
    END IF;
    EXECUTE format('UPDATE %I.mail_archive_bounds SET nrows=nrows+$2,unknown_rows=unknown_rows+$3,'
                   'assigned_max=$4,version=version+1 WHERE owner=$1',TG_TABLE_SCHEMA)
      USING recipient,delta_n,delta_bad,high;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION public.orgtree_install_mail_bounds(org_id bigint) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE s text := 'org_' || org_id; recipient text; source_n bigint; summary_n bigint;
BEGIN
  EXECUTE format('LOCK TABLE %I.log_d IN ACCESS EXCLUSIVE MODE',s);
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I.mail_archive_bounds('
                 'owner text PRIMARY KEY,nrows bigint NOT NULL CHECK(nrows>=0),'
                 'unknown_rows bigint NOT NULL CHECK(unknown_rows>=0 AND unknown_rows<=nrows),'
                 'assigned_max numeric NOT NULL CHECK(assigned_max>=0),'
                 'version bigint NOT NULL,format integer NOT NULL)',s);
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_mail_ordinal ON %I.log_d '
                 '(owner,public.orgtree_mail_ordinal(val) DESC) WHERE sect=''mail_log''',s);
  EXECUTE format('DROP TRIGGER IF EXISTS mail_archive_bounds ON %I.log_d',s);
  EXECUTE format('DROP TRIGGER IF EXISTS mail_archive_prepare ON %I.log_d',s);
  EXECUTE format('CREATE TRIGGER mail_archive_prepare BEFORE INSERT OR UPDATE OR DELETE ON %I.log_d '
                 'FOR EACH ROW EXECUTE FUNCTION public.orgtree_track_mail_archive()',s);
  EXECUTE format('CREATE TRIGGER mail_archive_bounds AFTER INSERT OR UPDATE OR DELETE ON %I.log_d '
                 'FOR EACH ROW EXECUTE FUNCTION public.orgtree_track_mail_archive()',s);
  EXECUTE format('DROP TRIGGER IF EXISTS mail_archive_truncate ON %I.log_d',s);
  EXECUTE format('CREATE TRIGGER mail_archive_truncate AFTER TRUNCATE ON %I.log_d '
                 'FOR EACH STATEMENT EXECUTE FUNCTION public.orgtree_truncate_mail_archive()',s);
  -- Re-running rebuilds only derived data and is safe after an interrupted
  -- migration or a restored source snapshot. Never trust a version marker alone.
  EXECUTE format('DELETE FROM %I.mail_archive_bounds',s);
  FOR recipient IN EXECUTE format('SELECT id FROM %I.nodes UNION '
                     'SELECT owner FROM %I.log_d WHERE sect=''mail_log''',s,s)
  LOOP
    PERFORM public.orgtree_reconcile_mail_owner(s,recipient);
  END LOOP;
  EXECUTE format('SELECT count(*) FROM %I.log_d WHERE sect=''mail_log''',s) INTO source_n;
  EXECUTE format('SELECT coalesce(sum(nrows),0) FROM %I.mail_archive_bounds',s) INTO summary_n;
  IF source_n <> summary_n THEN RAISE EXCEPTION 'mail archive reconciliation mismatch in %',s; END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION public.orgtree_truncate_mail_archive() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('UPDATE %I.mail_archive_bounds SET nrows=0,unknown_rows=0,assigned_max=0,version=version+1',
                 TG_TABLE_SCHEMA);
  RETURN NULL;
END
$fn$;

DO $migration$
DECLARE org record;
BEGIN
  FOR org IN SELECT org_id FROM public.orgs ORDER BY org_id LOOP
    PERFORM public.orgtree_install_mail_bounds(org.org_id);
  END LOOP;
END
$migration$;

-- Importers call the SQL creator directly. Wrap that shared door rather than
-- only the engine's Python caller; preserve any preceding schema additions.
DO $wrap$
BEGIN
  IF to_regprocedure('public.orgtree_create_org_schema_before_mail_bounds(bigint)') IS NULL THEN
    ALTER FUNCTION public.orgtree_create_org_schema(bigint) RENAME TO orgtree_create_org_schema_before_mail_bounds;
  END IF;
END
$wrap$;
CREATE OR REPLACE FUNCTION public.orgtree_create_org_schema(p_org_id bigint) RETURNS text
LANGUAGE plpgsql AS $fn$
DECLARE s text;
BEGIN
  s := public.orgtree_create_org_schema_before_mail_bounds(p_org_id);
  PERFORM public.orgtree_install_mail_bounds(p_org_id);
  RETURN s;
END
$fn$;
