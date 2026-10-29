-- Who got a copy of each outside message (user 2026-10-29 ma660da825904: "the detail of
-- mails in the org inbox should list every agent who the mail was delivered to"). Each holder
-- gets its own ot.mail copy, but nothing tied a copy back to its inbox row, so the viewer had
-- no record of who received it. `delivered_to` is that record: the agent names, in delivery
-- order and each once, written in the same transaction as the copies (publication, the
-- release of mail held under Do not disturb, and a Do not disturb pull). It is the record kept
-- at delivery, never worked out from today's holders.
--
-- Existing rows: only hub mail can be filled in, exactly, because its copies share the row's
-- (org_id, net_id) and the insert dedupes on it. Mail between two orgs of this engine has no
-- key on either side, and old imported rows have no copies, so their lists stay empty and the
-- viewer shows nothing for them. Never a guessed list.
ALTER TABLE ot.org_inbox ADD COLUMN IF NOT EXISTS delivered_to jsonb NOT NULL DEFAULT '[]';
ALTER TABLE ot.org_inbox ADD CONSTRAINT org_inbox_delivered_to_shape CHECK (jsonb_typeof(delivered_to) = 'array');

UPDATE ot.org_inbox i SET delivered_to = c.names
  FROM (SELECT org_id, net_id, jsonb_agg(recipient_name ORDER BY first_id) AS names
          FROM (SELECT org_id, net_id, recipient_name, min(id) AS first_id
                  FROM ot.mail
                 WHERE recipient_kind = 'agent' AND net_id IS NOT NULL
                 GROUP BY org_id, net_id, recipient_name) one_each
         GROUP BY org_id, net_id) c
 WHERE i.dir = 'in' AND i.org_id = c.org_id AND i.net_id = c.net_id;
