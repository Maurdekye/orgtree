-- Opening a gallery reads one oldest unread card, otherwise one newest card.
-- Read history is outside the unread index; re-presenting updates `at` and
-- puts the card back in it. The gallery's existing org/id index locates its page.
CREATE INDEX documents_opening_unread ON ot.documents (org_id, at, id)
    WHERE NOT dismissed AND (viewed_at IS NULL OR viewed_at < at);
CREATE INDEX documents_opening_newest ON ot.documents (org_id, at DESC, id DESC)
    WHERE NOT dismissed;
