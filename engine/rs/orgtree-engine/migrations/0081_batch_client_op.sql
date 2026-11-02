-- Batch queue submission (orgtree_message with jobs, rows or jobs_file;
-- user 2026-10-28, authorized 2026-11-01) stamps each job mail with a
-- client_op derived from the call's batch_key, so a retry after a lost
-- response finds the jobs it already queued instead of resending them.
-- That lookup is by org, sender and client_op; index it so it never scans
-- the sender's whole sent history.
CREATE INDEX mail_batch_client_op ON ot.mail (org_id, sender_agent_id, client_op)
  WHERE client_op IS NOT NULL;
