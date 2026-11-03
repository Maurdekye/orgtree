-- Agent state history rows (kind = "state", written by the agent's actor) are
-- read for the node-settings States tab newest first, in pages by seq and back
-- to the 7 day cut for its totals. Index exactly those rows so the read touches
-- only them and never scans the agent's whole transcript.
CREATE INDEX convo_state_rows ON ot.convo (agent_id, seq DESC)
  WHERE body->>'kind' = 'state';
