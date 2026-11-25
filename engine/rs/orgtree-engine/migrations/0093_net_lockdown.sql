-- 4.7.0: org mailbox lockdown (Mail hub 2.6.0 feature `lockdown`; docket
-- org-mailbox-lockdown-allow-list-mode-that-denies, user 2026-11-25 13:26Z
-- m0388b64a9372, answers 13:37Z, 14:08Z, 14:10Z). While it is on, only the
-- listed outside addresses reach the org mailbox; the hubs refuse everyone
-- else and the engine admits nobody else either.
--
-- user_mode is the user's setting: 'org' (Org decides, the default: the
-- org mailbox holders turn it on and off, `org_on`), 'on' (forced on; the
-- user edits the list) or 'off' (forced off). rev orders every change,
-- off included; each hub acknowledges the rev it enforces
-- (net_lockdown_hubs). set_aside: unlisted mail is set aside to read one at
-- a time rather than dropped. refused counts what was dropped.
CREATE TABLE ot.net_lockdown (
  org_id     bigint PRIMARY KEY REFERENCES ot.orgs (id),
  user_mode  text NOT NULL DEFAULT 'org' CHECK (user_mode IN ('org', 'on', 'off')),
  org_on     boolean NOT NULL DEFAULT false,
  set_aside  boolean NOT NULL DEFAULT false,
  set_by     text,
  set_at     timestamptz,
  rev        bigint NOT NULL DEFAULT 0,
  refused    bigint NOT NULL DEFAULT 0
);

-- An entry is an address on one hub (the org's hub id) and follows that
-- address there (user 14:08Z, answer 7); the same name on another hub is
-- someone else (review B3).
CREATE TABLE ot.net_lockdown_allow (
  org_id    bigint NOT NULL REFERENCES ot.net_lockdown (org_id) ON DELETE CASCADE,
  hub       text NOT NULL,
  address   text NOT NULL,
  added_by  text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, hub, address),
  CHECK (length(address) BETWEEN 1 AND 128)
);

-- What each hub last acknowledged: the rev it enforces, or why it doesn't.
CREATE TABLE ot.net_lockdown_hubs (
  org_id  bigint NOT NULL REFERENCES ot.net_lockdown (org_id) ON DELETE CASCADE,
  hub     text NOT NULL,
  rev     bigint,
  state   text NOT NULL CHECK (state IN ('enforced', 'pending', 'failed', 'unsupported')),
  detail  text,
  at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, hub)
);

-- Set-aside mail (user 13:37Z Q5, 14:08Z answers 2, 3, 8): an inbound
-- letter from an unlisted address, taken out of delivery. Nothing routes it
-- (no copies, jobs, promotion, grants or notices); it stays set aside after
-- the lockdown lifts and is read one at a time.
ALTER TABLE ot.org_inbox ADD COLUMN set_aside_at timestamptz;
ALTER TABLE ot.org_inbox ADD COLUMN set_aside_read_by text;
ALTER TABLE ot.org_inbox ADD COLUMN set_aside_read_at timestamptz;
-- what was not downloaded (files, a long body's size) and the letter's own reply reference
ALTER TABLE ot.org_inbox ADD COLUMN set_aside_meta jsonb;
CREATE INDEX org_inbox_set_aside ON ot.org_inbox (org_id, id) WHERE set_aside_at IS NOT NULL;

-- Outside communication gains "Org decides" (user 14:10Z m16ef9bb35e25):
-- org_inbox_mode is the user's value ('org' | 'normal' | 'dnd' | 'closed'),
-- org_inbox_org_mode the holders' choice ('normal' | 'closed'), and
-- org_inbox_enabled stays the effective gate every reader uses. Existing
-- orgs start on Org decides with their current mode as the org's choice;
-- Do not disturb is a user mode and stays the user's explicit value.
UPDATE ot.orgs
   SET settings = settings || jsonb_build_object(
         'org_inbox_mode', 'org',
         'org_inbox_org_mode', CASE WHEN settings->'org_inbox_enabled' = 'false'::jsonb OR settings->>'org_inbox_mode' = 'closed'
                                    THEN 'closed' ELSE 'normal' END)
 WHERE COALESCE(settings->>'org_inbox_mode', '') <> 'dnd'
    OR settings->'org_inbox_enabled' = 'false'::jsonb;
