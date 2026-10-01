-- Per-item active docket storage. Run offline under the root/migration lock.
-- Keep all fields as JSON TEXT: json (not jsonb) preserves numeric spellings,
-- key order and unknown fields. Each organization is additionally locked
-- against writers; the migration and its version receipt commit atomically.
ALTER TABLE public.orgs ADD COLUMN work_revision bigint NOT NULL DEFAULT 0;

DO $migration$
DECLARE
  org record; s text; original text; item json; item_text text; slug text;
  ids text[]; source_parts text[]; back_parts text[]; header text;
  count_before bigint; count_after bigint; affected bigint; rev bigint;
  before_sha text; after_sha text;
BEGIN
  FOR org IN SELECT o.org_id, o.slug FROM public.orgs o ORDER BY o.org_id LOOP
    s := 'org_' || org.org_id;
    EXECUTE format('LOCK TABLE %I.doc IN ACCESS EXCLUSIVE MODE', s);
    EXECUTE format('SELECT val FROM %I.doc WHERE key=$1', s)
      INTO original USING 'work_items';
    EXECUTE format('SELECT count(*) FROM %I.doc WHERE starts_with(key,$1)', s)
      INTO count_after USING 'work_items' || chr(31);
    IF count_after <> 0 THEN
      RAISE EXCEPTION 'work-items migration refuses mixed/orphan rows in %', s;
    END IF;
    IF original IS NULL THEN CONTINUE; END IF;
    IF json_typeof(original::json) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'work-items migration refuses unknown shape in %', s;
    END IF;
    ids := ARRAY[]::text[]; source_parts := ARRAY[]::text[];
    FOR item IN SELECT value FROM json_array_elements(original::json) LOOP
      IF json_typeof(item) IS DISTINCT FROM 'object'
         OR json_typeof(item->'slug') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'work-items migration refuses invalid item in %', s;
      END IF;
      slug := item->>'slug';
      IF slug = '' OR strpos(slug,chr(31)) <> 0 OR slug = ANY(ids) THEN
        RAISE EXCEPTION 'work-items migration refuses invalid/duplicate slug in %', s;
      END IF;
      ids := array_append(ids,slug);
      item_text := item::text;
      source_parts := array_append(source_parts,item_text);
      EXECUTE format('INSERT INTO %I.doc(key,val) VALUES($1,$2)', s)
        USING 'work_items' || chr(31) || slug, item_text;
    END LOOP;
    count_before := cardinality(ids);
    before_sha := encode(sha256(convert_to(array_to_json(source_parts)::text,'UTF8')),'hex');
    EXECUTE format('SELECT count(*) FROM %I.doc WHERE starts_with(key,$1)', s)
      INTO count_after USING 'work_items' || chr(31);
    EXECUTE format('SELECT coalesce(array_agg(d.val ORDER BY i.ord),ARRAY[]::text[]) '
                   'FROM unnest($1::text[]) WITH ORDINALITY i(slug,ord) '
                   'JOIN %I.doc d ON d.key=$2 || i.slug', s)
      INTO back_parts USING ids, 'work_items' || chr(31);
    after_sha := encode(sha256(convert_to(array_to_json(back_parts)::text,'UTF8')),'hex');
    IF count_after <> count_before OR before_sha <> after_sha OR source_parts <> back_parts THEN
      RAISE EXCEPTION 'work-items migration count/checksum mismatch in %', s;
    END IF;
    header := json_build_object('format','orgtree.work-items/v1','ids',ids)::text;
    EXECUTE format('UPDATE %I.doc SET val=$1 WHERE key=$2 AND val=$3',s)
      USING header,'work_items',original;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN RAISE EXCEPTION 'work-items migration stale header in %',s; END IF;
    INSERT INTO public.receipts(org_id,op_key,result)
      VALUES(org.org_id,'work-items-layout/v1',json_build_object(
        'format','orgtree.work-items/v1','count',count_after,'items_sha256',after_sha,
        'source_sha256',encode(sha256(convert_to(original,'UTF8')),'hex'))::text);
    UPDATE public.orgs SET revision=revision+1 WHERE org_id=org.org_id RETURNING revision INTO rev;
    PERFORM pg_notify('org_rev',org.slug || ':' || rev);
  END LOOP;
  -- Archive-only orgs also receive an initial committed content stamp.
  UPDATE public.orgs SET work_revision=revision;
END
$migration$;
