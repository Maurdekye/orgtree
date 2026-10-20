-- One outstanding, bounded handoff per agent. Payload is private mail, not
-- diagnostic data. Its native ID remains stable until positive admission or
-- bounded recovery at the owning turn boundary.
CREATE TABLE ot.opencode_mail_batches (
    agent_id bigint PRIMARY KEY REFERENCES ot.agents(id) ON DELETE CASCADE,
    org_id bigint NOT NULL,
    generation integer NOT NULL,
    turn_id bigint NOT NULL REFERENCES ot.turns(id) ON DELETE CASCADE,
    message_id text NOT NULL UNIQUE,
    session_id text NOT NULL,
    text text NOT NULL CHECK (octet_length(text) BETWEEN 1 AND 128000),
    mail_ids bigint[] NOT NULL CHECK (cardinality(mail_ids) BETWEEN 1 AND 32),
    transcript jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opencode_mail_turn ON ot.opencode_mail_batches(turn_id);
