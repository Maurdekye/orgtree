-- Conversation recall (orgtree_inbox action=conversation): one agent's mail
-- with one correspondent, newest first, read a page at a time. Each side of
-- a conversation is one short range of one of these indexes, so a page never
-- scans the rest of a long mailbox.
--   mail between two agents, either direction (recipient, sender)
--   and an agent's mail to the user (recipient NULL, sender)
CREATE INDEX mail_pair ON ot.mail (recipient_agent_id, sender_agent_id, created_at, id);
--   mail an agent received from the user or from outside (@org:, @net:)
CREATE INDEX mail_from_outside ON ot.mail (recipient_agent_id, sender, created_at, id) WHERE sender_agent_id IS NULL;
--   outside mail an agent sent from the org inbox
CREATE INDEX org_inbox_sent_by ON ot.org_inbox (org_id, by_name, peer, at, id) WHERE dir = 'out';
