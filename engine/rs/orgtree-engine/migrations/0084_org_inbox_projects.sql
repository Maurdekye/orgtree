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
