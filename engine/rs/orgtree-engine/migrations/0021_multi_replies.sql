-- Additive plural snapshots. Old rows remain untouched and normalize as
-- singletons at read time. New reverse links cost only their bounded targets.
ALTER TABLE ot.mail ADD COLUMN replies jsonb NOT NULL DEFAULT '[]';
ALTER TABLE ot.org_inbox ADD COLUMN replies jsonb NOT NULL DEFAULT '[]';
ALTER TABLE ot.mail ADD CONSTRAINT mail_replies_shape CHECK (jsonb_typeof(replies)='array' AND jsonb_array_length(replies)<=50);
ALTER TABLE ot.org_inbox ADD CONSTRAINT inbox_replies_shape CHECK (jsonb_typeof(replies)='array' AND jsonb_array_length(replies)<=50);
CREATE TABLE ot.reply_links (
  org_id bigint NOT NULL, box text NOT NULL, message_uid text NOT NULL,
  target text NOT NULL, PRIMARY KEY(org_id,box,target,message_uid)
);
CREATE INDEX reply_links_message ON ot.reply_links(org_id,box,message_uid);
CREATE FUNCTION ot.record_reply_links() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q jsonb; targets jsonb; box_name text;
BEGIN
  box_name := CASE WHEN TG_TABLE_NAME='mail' THEN 'mail' ELSE 'org' END;
  IF TG_OP='DELETE' THEN
    DELETE FROM ot.reply_links WHERE org_id=OLD.org_id AND box=box_name AND message_uid=OLD.uid;
    RETURN OLD;
  END IF;
  targets := NEW.replies;
  IF jsonb_array_length(targets)=0 AND NEW.reply_to IS NOT NULL THEN targets := jsonb_build_array(NEW.reply_to); END IF;
  DELETE FROM ot.reply_links WHERE org_id=NEW.org_id AND box=box_name AND message_uid=NEW.uid;
  FOR q IN SELECT value FROM jsonb_array_elements(targets) LOOP
    INSERT INTO ot.reply_links(org_id,box,message_uid,target)
    SELECT NEW.org_id,box_name,NEW.uid,coalesce(q->>'net_id',q->>'id',q#>>'{source_event_ref,eventId}')
    WHERE coalesce(q->>'net_id',q->>'id',q#>>'{source_event_ref,eventId}') IS NOT NULL
    ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER mail_reply_links AFTER INSERT OR UPDATE OF reply_to,replies OR DELETE ON ot.mail FOR EACH ROW EXECUTE FUNCTION ot.record_reply_links();
CREATE TRIGGER inbox_reply_links AFTER INSERT OR UPDATE OF reply_to,replies OR DELETE ON ot.org_inbox FOR EACH ROW EXECUTE FUNCTION ot.record_reply_links();
