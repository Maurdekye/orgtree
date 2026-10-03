-- A7b-W: facts the identity guard and abandoned-ticket pass need. Projections
-- are generated for every writer (including COPY/conversion), not a side cache.
-- Keep index entries below 1024 payload bytes. Wider values remain exact in
-- their original columns/extra; NULL headers make the reader refuse, not clip.
CREATE FUNCTION orgtree.archive_status_key(value text, extra json) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE projected text;
BEGIN
 projected := coalesce(orgtree.docket_field(extra,'status'),to_json(value),'null'::json)::text;
 IF octet_length(projected)>1024 THEN RETURN NULL; END IF;
 RETURN projected;
END
$fn$;

ALTER TABLE orgtree.work_items
 ADD COLUMN archive_identity_slug text GENERATED ALWAYS AS (
   CASE WHEN slug IS NOT NULL AND slug<>'' AND octet_length(slug)<=1024
          AND orgtree.docket_field(extra,'slug') IS NULL THEN slug END) STORED,
 ADD COLUMN archive_legacy_identity boolean GENERATED ALWAYS AS (
   orgtree.docket_field(extra,'id') IS NOT NULL) STORED,
 ADD COLUMN archive_status_key text GENERATED ALWAYS AS (
   orgtree.archive_status_key(status,extra)) STORED;

CREATE INDEX work_archive_identity_headers ON orgtree.work_items(ord)
 INCLUDE (archive_identity_slug,archive_legacy_identity) WHERE list_key='archive';
CREATE INDEX work_archive_status_keys ON orgtree.work_items(archive_status_key COLLATE "C")
 WHERE list_key='archive' AND archive_status_key IS NOT NULL;
CREATE INDEX work_archive_status_unreadable ON orgtree.work_items(id)
 WHERE list_key='archive' AND archive_status_key IS NULL;
