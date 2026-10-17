-- User-mail tags are relations, never an embedded mutable list in a mail row.
-- The first committed spelling is the org's label for this normalized key.
CREATE TABLE ot.mail_tags (
  org_id bigint NOT NULL REFERENCES ot.orgs(id) ON DELETE CASCADE,
  key text NOT NULL,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 32),
  PRIMARY KEY (org_id, key)
);
CREATE TABLE ot.mail_tag_links (
  mail_id bigint NOT NULL REFERENCES ot.mail(id) ON DELETE CASCADE,
  org_id bigint NOT NULL,
  tag_key text NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 7),
  PRIMARY KEY (mail_id, tag_key),
  UNIQUE (mail_id, ordinal),
  FOREIGN KEY (org_id, tag_key) REFERENCES ot.mail_tags(org_id, key) ON DELETE CASCADE
);
CREATE INDEX mail_tag_window ON ot.mail_tag_links(org_id, tag_key, mail_id DESC);

-- A wire projection only. At most eight indexed membership rows per mail.
CREATE FUNCTION ot.mail_tag_labels(mail bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(t.label ORDER BY l.ordinal), '[]'::jsonb)
    FROM ot.mail_tag_links l JOIN ot.mail_tags t ON t.org_id=l.org_id AND t.key=l.tag_key
   WHERE l.mail_id=mail
$$;
