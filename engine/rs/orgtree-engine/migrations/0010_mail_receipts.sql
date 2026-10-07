-- Startup repair starts from unresolved mail; receipt lookups must not scan
-- an agent's entire conversation history for every waiting message.
CREATE INDEX convo_mail_receipts ON ot.convo USING gin ((body->'mail_ids'))
  WHERE body->>'role' = 'user';
CREATE INDEX mail_delivering_ids ON ot.mail (id) WHERE state = 'delivering';
