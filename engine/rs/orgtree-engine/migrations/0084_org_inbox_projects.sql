-- Projects hold the org-inbox audience (USER 2026-11-03 mdf5da6c51202). Spec: org-inbox-queue-spec.md rev 2 §5.
-- via_job: the queue job a worker's outside reply came from (D10/D13); never sent on the hub wire.
ALTER TABLE ot.org_inbox ADD COLUMN IF NOT EXISTS via_job text;
-- D14: the project's job for an org-inbox row, bounded to outside jobs.
CREATE INDEX IF NOT EXISTS mail_org_inbox_job
  ON ot.mail (recipient_agent_id, (extra->'org_inbox'->>'uid'))
  WHERE extra ? 'org_inbox';
-- D14: hand-out of the follow-ups bundled with a job.
CREATE INDEX IF NOT EXISTS mail_bundled_with
  ON ot.mail ((extra->>'bundled_with'))
  WHERE extra ? 'bundled_with';
-- D3a (rev 2.2): "top-level" for OUTSIDE mail only. No agent superior AND no project above the agent
-- (itself included) currently holds an active org-inbox grant: members of a holding project get only the
-- job-scoped reply right. User mail and everything else keep ot.superior_of.
CREATE OR REPLACE FUNCTION ot.outside_top_level(agent bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT ot.superior_of(agent) IS NULL AND NOT EXISTS (
    WITH RECURSIVE up(id, parent_id) AS (
      SELECT a.id, a.parent_id FROM ot.agents a WHERE a.id = agent
      UNION
      SELECT a.id, a.parent_id FROM ot.agents a JOIN up ON a.id = up.parent_id)
    SELECT 1 FROM up JOIN ot.agents p ON p.id = up.id AND p.kind = 'project'
      JOIN ot.audiences au ON au.org_id = p.org_id AND au.grantee = p.name AND au.grantor = '@extern'
       AND au.revoked_at IS NULL AND NOT au.paused)
$$;
