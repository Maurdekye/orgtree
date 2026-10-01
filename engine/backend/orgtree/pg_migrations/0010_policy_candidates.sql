-- Periodic policy candidates are NOT synonymous with live nodes. Archived
-- nodes with a truthy freeze still receive resume-deadline bookkeeping.
-- Native partial indexes follow INSERT/COPY/UPDATE/DELETE transactionally;
-- there is no separately maintained summary to become stale.
CREATE OR REPLACE FUNCTION public.orgtree_install_policy_candidates(p_org_id bigint)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE s text := 'org_' || p_org_id;
BEGIN
  EXECUTE format($sql$
    CREATE INDEX IF NOT EXISTS ix_policy_candidates ON %I.nodes(ord,id)
    WHERE val::jsonb->>'state'='live' OR
      coalesce(val::jsonb->'frozen','null'::jsonb) NOT IN
        ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb,'[]'::jsonb,'{}'::jsonb)
  $sql$,s);
  EXECUTE format($sql$
    CREATE INDEX IF NOT EXISTS ix_policy_settings ON %I.doc(key)
    WHERE strpos(key,chr(31))=0 AND key NOT IN (
      'nodes','work_items','mail','delivering','notices','mail_log','steered_log',
      'turn_error_log','steer_attempts','work_scope_log','events','org_inbox',
      'notice_log','user_mail_log','user_outbox','documents','watchdog_history',
      'op_receipts','work_items_archive','lifecycle','watchdogs','watchdog_tombs',
      'reservations','credit_requests')
  $sql$,s);
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_install_policy_candidates(bigint) FROM PUBLIC;

DO $migration$
DECLARE org record;
BEGIN
  FOR org IN SELECT org_id FROM public.orgs ORDER BY org_id LOOP
    PERFORM public.orgtree_install_policy_candidates(org.org_id);
  END LOOP;
END
$migration$;

DO $wrap$
BEGIN
  IF to_regprocedure('public.orgtree_create_org_schema_before_policy_candidates(bigint)') IS NULL THEN
    ALTER FUNCTION public.orgtree_create_org_schema(bigint) RENAME TO orgtree_create_org_schema_before_policy_candidates;
  END IF;
END
$wrap$;
CREATE OR REPLACE FUNCTION public.orgtree_create_org_schema(p_org_id bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE s text;
BEGIN
  s := public.orgtree_create_org_schema_before_policy_candidates(p_org_id);
  PERFORM public.orgtree_install_policy_candidates(p_org_id);
  RETURN s;
END
$fn$;
REVOKE ALL ON FUNCTION public.orgtree_create_org_schema(bigint) FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='orgtree_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.orgtree_create_org_schema(bigint) TO orgtree_runtime;
  END IF;
END
$grants$;
