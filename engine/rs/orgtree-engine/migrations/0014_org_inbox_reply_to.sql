-- The message an org-inbox row answers: the quote its reader sees (who
-- wrote it, when, a gist) and, for mail over the hub, the hub id the
-- reply carries (`net_id`). NULL for a row that answers nothing.
ALTER TABLE ot.org_inbox ADD COLUMN reply_to jsonb;
