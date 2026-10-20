-- Rechecking a stopped agent must not scan retained project/user mail.
-- Match domain/projects.rs OUTSTANDING exactly (including coalesce).
CREATE INDEX mail_active_claim_holder ON ot.mail
  (((extra->'claimed'->>'by_id')::bigint), org_id, recipient_agent_id)
  WHERE state='read' AND coalesce((extra->'claimed'->>'ack')::boolean,false)
    AND extra->'claimed'->>'acked_at' IS NULL;
CREATE INDEX slot_leases_active_holder ON ot.slot_leases(holder_agent_id,project_id)
  WHERE ended_at IS NULL;
