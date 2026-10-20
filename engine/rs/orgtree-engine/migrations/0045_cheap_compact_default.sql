-- Automatic cheap compaction now defaults ON for new orgs (user 2026-10-20).
-- Pin EXISTING orgs to their old effective value, including trashed orgs.
-- Org settings replace the whole app value; they do not merge key by key.
-- An explicit org enabled choice already pins it and is left byte-for-byte.
-- Do not materialize app defaults: absence there must now mean ON/25%.
WITH old AS (
    SELECT id,
           CASE WHEN settings ? 'auto_cheap_compact'
                THEN settings->'auto_cheap_compact'
                ELSE coalesce((SELECT value #> '{defaults,auto_cheap_compact}'
                               FROM ot.kv WHERE key = 'app_settings'), '{}'::jsonb)
           END AS acc
    FROM ot.orgs
    WHERE jsonb_typeof(settings #> '{auto_cheap_compact,enabled}') IS DISTINCT FROM 'boolean'
)
UPDATE ot.orgs AS o
SET settings = o.settings || jsonb_build_object('auto_cheap_compact', jsonb_build_object(
        'enabled', CASE WHEN jsonb_typeof(old.acc->'enabled') = 'boolean'
                        THEN (old.acc->>'enabled')::boolean ELSE false END,
        'occ', CASE WHEN jsonb_typeof(old.acc->'occ') = 'number'
                    THEN greatest(0.05, least(0.95, (old.acc->>'occ')::numeric)) ELSE 0.25 END)),
    row_version = row_version + 1
FROM old WHERE o.id = old.id;
