-- Harden 0013's custody receipt functions (review finding f2).
-- 1. pg_temp LAST: left out of search_path it is searched FIRST for
--    relations, so a caller's temp table could shadow an unqualified name
--    (pg_roles in orgtree_install_receipt_rows).
-- 2. 0013 renamed the schema creator to ..._before_receipts without taking
--    the runtime's EXECUTE away; it would create an org schema with no
--    receipt tables. 0004 and 0014 revoke their renamed predecessors.
ALTER FUNCTION public.orgtree_install_receipt_rows(bigint)
  SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION public.orgtree_put_receipt(bigint,text,text,text,text)
  SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION public.orgtree_delete_receipt(bigint,text,text,text)
  SET search_path=pg_catalog,public,pg_temp;
DO $grant$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='orgtree_runtime') THEN
    REVOKE ALL ON FUNCTION public.orgtree_create_org_schema_before_receipts(bigint) FROM orgtree_runtime;
  END IF;
END
$grant$;
