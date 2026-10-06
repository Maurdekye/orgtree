-- When the CLI was handed a turn's opening message. Crash recovery uses it
-- to tell mail the CLI already holds (delivered) from mail that never
-- reached it (back to the queue).
ALTER TABLE ot.turns ADD COLUMN sent_at timestamptz;
CREATE INDEX turns_open ON ot.turns (agent_id) WHERE ended_at IS NULL;
