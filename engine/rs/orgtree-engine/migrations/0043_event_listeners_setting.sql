-- A project's event-listeners setting (docket
-- project-event-listeners-an-enable-setting-off-by; user 2026-10-20 10:50Z,
-- design approved by the coordinator 10:58Z): `scope.event_listeners`, OFF
-- (absent) by default, decides the project's event Listeners tab and whether
-- its project_listener and listener_watch dogs work at all.
--
-- Existing projects keep working: every project whose Listeners tab showed
-- before this migration (`extra.listeners_seen_at`, stamped by every listener
-- or watch create since migration 0040, which backfilled it from every such
-- dog ever kept), and every project keeping an armed or paused listener or
-- watch now, starts ON. A written setting is never overwritten, so the
-- statement is idempotent (tools/rig/proofs/project-listener-setting.mjs
-- runs it twice).
UPDATE ot.agents a
   SET scope = jsonb_set(coalesce(a.scope, '{}'::jsonb), '{event_listeners}', 'true'::jsonb)
 WHERE a.kind = 'project'
   AND NOT (coalesce(a.scope, '{}'::jsonb) ? 'event_listeners')
   AND (a.extra ? 'listeners_seen_at'
        OR EXISTS (SELECT 1 FROM ot.watchdogs w
                    WHERE w.org_id = a.org_id AND w.kind IN ('project_listener', 'listener_watch')
                      AND w.state IN ('armed', 'paused') AND w.memo->>'target_id' = a.id::text));
