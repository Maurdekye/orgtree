-- Active-only keyset pages; retained completed mail/work/leases cannot pin a
-- reminder scan. The second work index makes the whole-org all-blocked test
-- two existence probes rather than a scan of every blocked row.
CREATE INDEX work_items_reminder_page ON ot.work_items(org_id,slug)
 WHERE archived_at IS NULL AND NOT coalesce((extra->>'deleted')::boolean,false)
 AND status NOT IN ('done','superseded','dropped','backlogged');
CREATE INDEX work_items_reminder_unblocked ON ot.work_items(org_id)
 WHERE archived_at IS NULL AND NOT coalesce((extra->>'deleted')::boolean,false)
 AND status NOT IN ('done','superseded','dropped','backlogged') AND status<>'blocked';
CREATE INDEX mail_checkup_page ON ot.mail(((extra->'claimed'->>'by_id')::bigint),id)
 WHERE state='read' AND coalesce((extra->'claimed'->>'ack')::boolean,false)
 AND extra->'claimed'->>'acked_at' IS NULL;
CREATE INDEX slot_checkup_page ON ot.slot_leases(holder_agent_id,id) WHERE ended_at IS NULL;
