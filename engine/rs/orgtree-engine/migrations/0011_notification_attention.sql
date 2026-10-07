-- A dismissal revision is not an attention lifetime. Reconcile the final
-- transaction state, as 3.x did, so manual/question handoffs keep one epoch.
ALTER TABLE ot.work_items ADD COLUMN notification_attention_epoch bigint;
ALTER TABLE ot.work_items ADD COLUMN notification_attention_active boolean;

CREATE INDEX asks_work_attention ON ot.asks USING gin (work_items) WHERE status = 'open';

UPDATE ot.work_items w
   SET notification_attention_epoch = coalesce((manual_attention->>'set_rev')::bigint, 1),
       notification_attention_active = manual_attention IS NOT NULL OR EXISTS (
           SELECT 1 FROM ot.asks q WHERE q.org_id = w.org_id AND q.status = 'open'
             AND q.work_items @> ARRAY[w.slug]);

CREATE FUNCTION ot.reconcile_notification_attention(item_id bigint) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    w ot.work_items%ROWTYPE;
    active_now boolean;
    next_epoch bigint;
BEGIN
    -- Per-item serialization only; no org/global lock. Re-read questions after
    -- obtaining the row lock so a concurrent committed source change is seen.
    SELECT * INTO w FROM ot.work_items WHERE id = item_id FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    SELECT w.manual_attention IS NOT NULL OR EXISTS (
        SELECT 1 FROM ot.asks q WHERE q.org_id = w.org_id AND q.status = 'open'
          AND q.work_items @> ARRAY[w.slug]) INTO active_now;
    next_epoch := coalesce(w.notification_attention_epoch, (w.manual_attention->>'set_rev')::bigint, 1);
    IF w.notification_attention_active = false AND active_now THEN
        next_epoch := next_epoch + 1;
    END IF;
    IF w.notification_attention_active IS DISTINCT FROM active_now
       OR w.notification_attention_epoch IS DISTINCT FROM next_epoch THEN
        UPDATE ot.work_items SET notification_attention_active = active_now,
               notification_attention_epoch = next_epoch WHERE id = item_id;
    END IF;
END $$;

CREATE FUNCTION ot.work_notification_attention_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM ot.reconcile_notification_attention(NEW.id);
    ELSIF NEW.manual_attention IS DISTINCT FROM OLD.manual_attention THEN
        PERFORM ot.reconcile_notification_attention(NEW.id);
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER work_notification_attention_changed
AFTER INSERT OR UPDATE ON ot.work_items DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ot.work_notification_attention_changed();

CREATE FUNCTION ot.ask_notification_attention_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    before_org bigint;
    after_org bigint;
    before_items text[] := '{}';
    after_items text[] := '{}';
    item_id bigint;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        before_org := OLD.org_id;
        before_items := OLD.work_items;
    END IF;
    IF TG_OP <> 'DELETE' THEN
        after_org := NEW.org_id;
        after_items := NEW.work_items;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF OLD.org_id = NEW.org_id AND OLD.status = NEW.status AND OLD.work_items = NEW.work_items THEN
            RETURN NULL;
        END IF;
    END IF;
    FOR item_id IN SELECT id FROM ot.work_items
        WHERE (org_id = before_org AND slug = ANY(before_items))
           OR (org_id = after_org AND slug = ANY(after_items)) ORDER BY id
    LOOP
        PERFORM ot.reconcile_notification_attention(item_id);
    END LOOP;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ask_notification_attention_changed
AFTER INSERT OR UPDATE OR DELETE ON ot.asks DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ot.ask_notification_attention_changed();
