-- Docket items no longer attach to projects (user 2026-10-17 22:21Z,
-- superseding the 2026-10-16 20:23Z ruling): a project's docket lists the
-- items OWNED by the agents under it. Nothing is lost: an item keeps its
-- owner, history and every other field, and the old attachment is kept as
-- `former_project_id` for the record, with no rights attached to it.
UPDATE ot.work_items
   SET extra = (extra - 'project_id') || jsonb_build_object('former_project_id', extra->'project_id')
 WHERE extra ? 'project_id';
