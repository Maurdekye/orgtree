-- Preserve the sender's kind across the hub spool; old rows were messages.
ALTER TABLE ot.org_inbox ADD COLUMN kind text NOT NULL DEFAULT 'message';

-- A holder's delivery must retain the exact hub receipt destination.
-- Human inbox read state is independent of this agent-consumption evidence.
ALTER TABLE ot.mail ADD COLUMN net_id text;
ALTER TABLE ot.mail ADD COLUMN net_hub text;
