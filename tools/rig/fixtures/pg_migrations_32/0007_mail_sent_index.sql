-- A bounded Sent tail needs the complete historical tie key in one index.
-- Keep source values in log_d; this table contains only selection/order keys.
CREATE OR REPLACE FUNCTION public.orgtree_track_mail_sent() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE recipient text; first_seq bigint; indexed_first bigint;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.sect='mail_log' THEN
    EXECUTE format('DELETE FROM %I.mail_sent WHERE seq=$1',TG_TABLE_SCHEMA) USING OLD.seq;
  END IF;
  -- Appends leave first_seq unchanged: two indexed first-row lookups, no
  -- history walk. Removing/moving a first row repairs only that owner's keys.
  -- COPY/statement updates may expose all final source rows to AFTER triggers.
  FOR recipient IN
    SELECT DISTINCT x FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' AND OLD.sect='mail_log' THEN OLD.owner END,
      CASE WHEN TG_OP <> 'DELETE' AND NEW.sect='mail_log' THEN NEW.owner END]) x
    WHERE x IS NOT NULL ORDER BY x
  LOOP
    EXECUTE format('SELECT seq FROM %I.log_d WHERE sect=''mail_log'' AND owner=$1 '
                   'ORDER BY seq LIMIT 1',TG_TABLE_SCHEMA) INTO first_seq USING recipient;
    IF first_seq IS NULL THEN
      EXECUTE format('DELETE FROM %I.mail_sent WHERE owner=$1',TG_TABLE_SCHEMA) USING recipient;
    ELSE
      EXECUTE format('SELECT owner_pos FROM %I.mail_sent WHERE owner=$1 ORDER BY seq LIMIT 1',
                     TG_TABLE_SCHEMA) INTO indexed_first USING recipient;
      IF indexed_first IS DISTINCT FROM first_seq THEN
        EXECUTE format('UPDATE %I.mail_sent SET owner_pos=$2 WHERE owner=$1',TG_TABLE_SCHEMA)
          USING recipient,first_seq;
      END IF;
    END IF;
  END LOOP;
  IF TG_OP <> 'DELETE' AND NEW.sect='mail_log' THEN
    EXECUTE format('SELECT seq FROM %I.log_d WHERE sect=''mail_log'' AND owner=$1 '
                   'ORDER BY seq LIMIT 1',TG_TABLE_SCHEMA) INTO first_seq USING NEW.owner;
    EXECUTE format('INSERT INTO %I.mail_sent(seq,owner,sender,sent_at,owner_pos) '
                   'VALUES($1,$2,$3,$4,$5)',TG_TABLE_SCHEMA)
      USING NEW.seq,NEW.owner,public.json_extract(NEW.val,'$.from'),
            coalesce(public.json_extract(NEW.val,'$.at'),''),first_seq;
  END IF;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.orgtree_truncate_mail_sent() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('TRUNCATE %I.mail_sent',TG_TABLE_SCHEMA);
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.orgtree_install_mail_sent(org_id bigint) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE s text := 'org_' || org_id; source_n bigint; index_n bigint;
BEGIN
  EXECUTE format('LOCK TABLE %I.log_d IN ACCESS EXCLUSIVE MODE',s);
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I.mail_sent('
                 'seq bigint PRIMARY KEY,owner text NOT NULL,sender text,'
                 'sent_at text NOT NULL,owner_pos bigint NOT NULL)',s);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='orgtree_runtime') THEN
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I.mail_sent TO orgtree_runtime',s);
  END IF;
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_mail_sent_tail ON %I.mail_sent '
                 '(sender,sent_at DESC,owner_pos DESC,seq DESC)',s);
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_mail_sent_owner ON %I.mail_sent(owner,seq)',s);
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_user_mail_sender ON %I.log_l '
                 '(public.json_extract(val,''$.from''),'
                 '(coalesce(public.json_extract(val,''$.at''),'''')) DESC,seq DESC) '
                 'WHERE sect=''user_mail_log''',s);
  EXECUTE format('DROP TRIGGER IF EXISTS mail_sent_update ON %I.log_d',s);
  EXECUTE format('CREATE TRIGGER mail_sent_update AFTER INSERT OR UPDATE OR DELETE ON %I.log_d '
                 'FOR EACH ROW EXECUTE FUNCTION public.orgtree_track_mail_sent()',s);
  EXECUTE format('DROP TRIGGER IF EXISTS mail_sent_truncate ON %I.log_d',s);
  EXECUTE format('CREATE TRIGGER mail_sent_truncate AFTER TRUNCATE ON %I.log_d '
                 'FOR EACH STATEMENT EXECUTE FUNCTION public.orgtree_truncate_mail_sent()',s);
  EXECUTE format('TRUNCATE %I.mail_sent',s);
  EXECUTE format('INSERT INTO %I.mail_sent(seq,owner,sender,sent_at,owner_pos) '
                 'SELECT seq,owner,public.json_extract(val,''$.from''),'
                 'coalesce(public.json_extract(val,''$.at''),''''),'
                 'min(seq) OVER(PARTITION BY owner) FROM %I.log_d WHERE sect=''mail_log''',s,s);
  EXECUTE format('SELECT count(*) FROM %I.log_d WHERE sect=''mail_log''',s) INTO source_n;
  EXECUTE format('SELECT count(*) FROM %I.mail_sent',s) INTO index_n;
  IF source_n <> index_n THEN RAISE EXCEPTION 'Sent index reconciliation mismatch in %',s; END IF;
END
$fn$;

DO $migration$
DECLARE org record;
BEGIN
  FOR org IN SELECT org_id FROM public.orgs ORDER BY org_id LOOP
    PERFORM public.orgtree_install_mail_sent(org.org_id);
  END LOOP;
END
$migration$;

DO $wrap$
BEGIN
  IF to_regprocedure('public.orgtree_create_org_schema_before_mail_sent(bigint)') IS NULL THEN
    ALTER FUNCTION public.orgtree_create_org_schema(bigint) RENAME TO orgtree_create_org_schema_before_mail_sent;
  END IF;
END
$wrap$;
CREATE OR REPLACE FUNCTION public.orgtree_create_org_schema(p_org_id bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE s text;
BEGIN
  s := public.orgtree_create_org_schema_before_mail_sent(p_org_id);
  PERFORM public.orgtree_install_mail_sent(p_org_id);
  RETURN s;
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_create_org_schema(bigint) FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='orgtree_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.orgtree_create_org_schema(bigint) TO orgtree_runtime;
  END IF;
END
$grants$;
