-- The actor writes these receipts in the same transaction as the step's
-- thinking/response rows. No text is retained here; exact lookup is indexed.
CREATE TABLE ot.agy_step_receipts (
    agent_id bigint NOT NULL REFERENCES ot.agents(id) ON DELETE CASCADE,
    session_id text NOT NULL,
    step_index bigint NOT NULL CHECK (step_index >= 0),
    has_response boolean NOT NULL,
    PRIMARY KEY (agent_id, session_id, step_index)
);
