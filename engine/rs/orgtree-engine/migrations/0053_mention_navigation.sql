-- Navigation history is separate from pending attention. Clearing attention
-- must not remove a destination. No historical content is scanned here.
CREATE TABLE ot.mention_navigation_state (
    org_id bigint PRIMARY KEY REFERENCES ot.orgs(id) ON DELETE CASCADE,
    seeded boolean NOT NULL DEFAULT false
);
CREATE TABLE ot.mention_navigation (
    id bigserial PRIMARY KEY,
    org_id bigint NOT NULL REFERENCES ot.orgs(id) ON DELETE CASCADE,
    source_key text NOT NULL,
    at timestamptz NOT NULL,
    target jsonb NOT NULL,
    blurb text NOT NULL,
    UNIQUE(org_id, source_key)
);
CREATE INDEX mention_navigation_cursor ON ot.mention_navigation(org_id, at DESC, id DESC);

CREATE FUNCTION ot.record_user_mention(o bigint, k text, stamp timestamptz, dest jsonb, excerpt text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    -- Match the FK lock order before the feed guard; org-mail publication can
    -- already hold its org row while publishing a local cross-org pair.
    PERFORM id FROM ot.orgs WHERE id=o FOR KEY SHARE;
    INSERT INTO ot.mention_navigation_state(org_id) VALUES(o) ON CONFLICT DO NOTHING;
    -- Serialize only this org's bounded feed; no source row is locked here.
    PERFORM org_id FROM ot.mention_navigation_state WHERE org_id=o FOR UPDATE;
    INSERT INTO ot.mention_navigation(org_id,source_key,at,target,blurb)
      VALUES(o,k,stamp,dest,left(excerpt,2000))
      ON CONFLICT(org_id,source_key) DO UPDATE SET blurb=EXCLUDED.blurb;
    DELETE FROM ot.mention_navigation WHERE org_id=o AND id IN (
      SELECT id FROM ot.mention_navigation WHERE org_id=o
      ORDER BY at DESC,id DESC OFFSET 2000);
END $$;

CREATE FUNCTION ot.capture_navigation_marker() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m jsonb; dest jsonb; k text;
BEGIN
    IF TG_TABLE_NAME='agents' THEN
      IF NEW.state='deleted' THEN
        PERFORM id FROM ot.orgs WHERE id=NEW.org_id FOR KEY SHARE;
        PERFORM org_id FROM ot.mention_navigation_state WHERE org_id=NEW.org_id FOR UPDATE;
        DELETE FROM ot.mention_navigation WHERE org_id=NEW.org_id AND source_key LIKE 'agent:'||NEW.id||':%';
        RETURN NEW;
      END IF;
      IF TG_OP='UPDATE' AND NEW.name IS DISTINCT FROM OLD.name THEN
        PERFORM id FROM ot.orgs WHERE id=NEW.org_id FOR KEY SHARE;
        PERFORM org_id FROM ot.mention_navigation_state WHERE org_id=NEW.org_id FOR UPDATE;
        UPDATE ot.mention_navigation SET target=jsonb_set(target,'{node}',to_jsonb(NEW.name))
          WHERE org_id=NEW.org_id AND source_key LIKE 'agent:'||NEW.id||':%';
      END IF;
    ELSIF coalesce((NEW.extra->>'deleted')::boolean,false) THEN
      PERFORM id FROM ot.orgs WHERE id=NEW.org_id FOR KEY SHARE;
      PERFORM org_id FROM ot.mention_navigation_state WHERE org_id=NEW.org_id FOR UPDATE;
      DELETE FROM ot.mention_navigation WHERE org_id=NEW.org_id AND source_key LIKE 'work:'||NEW.id||':%';
      RETURN NEW;
    END IF;
    m := NEW.extra->'user_mention';
    IF m IS NULL OR m='null'::jsonb OR m->>'at' IS NULL
      OR NOT pg_input_is_valid(m->>'at','timestamp with time zone') THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND m IS NOT DISTINCT FROM OLD.extra->'user_mention' THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME='agents' THEN
      k := 'agent:'||NEW.id||':'||(m->>'id');
      dest := jsonb_build_object('kind','agent','node',NEW.name,'generation',NEW.generation,
        'mention_id',m->>'id','event_id',m->>'event_id');
    ELSE
      k := 'work:'||NEW.id||':'||(m->>'rev');
      dest := jsonb_build_object('kind','work','item',NEW.slug,'rev',m->'rev');
    END IF;
    IF k IS NOT NULL THEN
      PERFORM ot.record_user_mention(NEW.org_id,k,(m->>'at')::timestamptz,dest,coalesce(m->>'blurb',''));
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER agent_navigation_marker AFTER INSERT OR UPDATE OF extra,name,state ON ot.agents
  FOR EACH ROW EXECUTE FUNCTION ot.capture_navigation_marker();
CREATE TRIGGER work_navigation_marker AFTER INSERT OR UPDATE OF extra ON ot.work_items
  FOR EACH ROW EXECUTE FUNCTION ot.capture_navigation_marker();

CREATE FUNCTION ot.remove_navigation_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM id FROM ot.orgs WHERE id=OLD.org_id FOR KEY SHARE;
    PERFORM org_id FROM ot.mention_navigation_state WHERE org_id=OLD.org_id FOR UPDATE;
    IF TG_TABLE_NAME IN ('mail','org_inbox') THEN
      DELETE FROM ot.mention_navigation WHERE org_id=OLD.org_id
        AND source_key=(CASE WHEN TG_TABLE_NAME='mail' THEN 'mail:' ELSE 'orgmail:' END)||OLD.uid;
    ELSE
      DELETE FROM ot.mention_navigation WHERE org_id=OLD.org_id
        AND source_key LIKE (CASE WHEN TG_TABLE_NAME='agents' THEN 'agent:' ELSE 'work:' END)||OLD.id||':%';
    END IF;
    RETURN OLD;
END $$;
CREATE TRIGGER agent_navigation_delete AFTER DELETE ON ot.agents FOR EACH ROW EXECUTE FUNCTION ot.remove_navigation_source();
CREATE TRIGGER work_navigation_delete AFTER DELETE ON ot.work_items FOR EACH ROW EXECUTE FUNCTION ot.remove_navigation_source();
CREATE TRIGGER mail_navigation_delete AFTER DELETE ON ot.mail FOR EACH ROW EXECUTE FUNCTION ot.remove_navigation_source();
CREATE TRIGGER mail_navigation_retract AFTER UPDATE OF state ON ot.mail FOR EACH ROW
  WHEN (NEW.state='retracted') EXECUTE FUNCTION ot.remove_navigation_source();
CREATE TRIGGER orgmail_navigation_delete AFTER DELETE ON ot.org_inbox FOR EACH ROW EXECUTE FUNCTION ot.remove_navigation_source();
