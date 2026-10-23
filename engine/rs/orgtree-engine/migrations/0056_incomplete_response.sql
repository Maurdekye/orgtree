-- Late native completions find their retained text without scanning history.
CREATE UNIQUE INDEX convo_incomplete_key ON ot.convo (agent_id, (body->>'incomplete_key'))
    WHERE body ? 'incomplete_key';
