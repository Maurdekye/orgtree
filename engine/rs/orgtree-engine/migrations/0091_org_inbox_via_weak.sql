-- Weak links to the org mailbox (USER 2026-11-24 18:56:37Z m020bbd1926c3; audiences grantor '@extern-weak'):
-- a message an agent sent over its weak link, so a reply comes back to it only while the link stands.
ALTER TABLE ot.org_inbox ADD COLUMN via_weak boolean NOT NULL DEFAULT false;
