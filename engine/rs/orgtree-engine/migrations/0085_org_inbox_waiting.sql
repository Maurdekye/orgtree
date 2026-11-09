-- Outside mail that arrived while no org-mailbox holder existed waits for the first holder (USER 2026-11-09
-- m01535356a9d7; docket org-mail-that-arrives-before-any-mailbox-holder-e). The release pass finds such rows by this
-- index: unread inbound rows nobody got a copy of and nobody pulled.
CREATE INDEX IF NOT EXISTS org_inbox_waiting ON ot.org_inbox (org_id, id)
  WHERE dir = 'in' AND NOT read AND pulled_by IS NULL AND delivered_to = '[]'::jsonb;
