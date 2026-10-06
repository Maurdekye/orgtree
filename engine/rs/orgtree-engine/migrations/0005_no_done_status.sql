-- An agent is never "done" (retired in v1): a "done" report leaves it idle.
UPDATE ot.agents SET last_status = jsonb_set(last_status, '{status}', '"idle"')
 WHERE last_status->>'status' = 'done';
UPDATE ot.agents SET prev_status = jsonb_set(prev_status, '{status}', '"idle"')
 WHERE prev_status->>'status' = 'done';
