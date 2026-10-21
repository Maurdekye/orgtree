-- Exact totals must not scan retained answered OR dropped mail. Backfill once
-- under the migration transaction's write exclusion, then maintain membership
-- changes transactionally with mail. Zero rows are removed, not retained.
LOCK TABLE ot.mail IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE ot.project_dead_letter_counts (
    recipient_agent_id bigint PRIMARY KEY,
    open_count bigint NOT NULL CHECK (open_count >= 0),
    dropped_count bigint NOT NULL CHECK (dropped_count >= 0)
);
INSERT INTO ot.project_dead_letter_counts
SELECT recipient_agent_id,
       count(*) FILTER (WHERE NOT (extra ? 'dead_letter_dropped')),
       count(*) FILTER (WHERE extra ? 'dead_letter_dropped')
  FROM ot.mail
 WHERE recipient_agent_id IS NOT NULL AND state = 'read' AND extra ? 'dead_letter'
 GROUP BY recipient_agent_id;

-- Match domain/dead_letters.rs OPEN / ANY exactly and satisfy newest-first
-- paging without filtering newer completed jobs or sorting retained history.
CREATE INDEX mail_dead_letters_open ON ot.mail(recipient_agent_id, id DESC)
    WHERE state = 'read' AND extra ? 'dead_letter' AND NOT (extra ? 'dead_letter_dropped');
CREATE INDEX mail_dead_letters_any ON ot.mail(recipient_agent_id, id DESC)
    WHERE state = 'read' AND extra ? 'dead_letter';

CREATE FUNCTION ot.maintain_dead_letter_counts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    old_recipient bigint; new_recipient bigint;
    old_open bigint := 0; old_dropped bigint := 0;
    new_open bigint := 0; new_dropped bigint := 0;
    delta record;
BEGIN
    IF TG_OP <> 'INSERT' AND OLD.recipient_agent_id IS NOT NULL
       AND OLD.state = 'read' AND OLD.extra ? 'dead_letter' THEN
        old_recipient := OLD.recipient_agent_id;
        old_dropped := (OLD.extra ? 'dead_letter_dropped')::integer;
        old_open := 1 - old_dropped;
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.recipient_agent_id IS NOT NULL
       AND NEW.state = 'read' AND NEW.extra ? 'dead_letter' THEN
        new_recipient := NEW.recipient_agent_id;
        new_dropped := (NEW.extra ? 'dead_letter_dropped')::integer;
        new_open := 1 - new_dropped;
    END IF;
    -- No counter writes for ordinary mail, or unchanged membership. A move
    -- locks the affected recipient counters in id order; there is no global
    -- counter lock. Mail's existing nullable/non-FK recipient semantics stay.
    FOR delta IN
        SELECT recipient, sum(o)::bigint AS opened, sum(d)::bigint AS dropped
          FROM (VALUES (old_recipient, -old_open, -old_dropped),
                       (new_recipient, new_open, new_dropped)) AS changes(recipient,o,d)
         WHERE recipient IS NOT NULL
         GROUP BY recipient HAVING sum(o) <> 0 OR sum(d) <> 0
         ORDER BY recipient
    LOOP
        INSERT INTO ot.project_dead_letter_counts VALUES(delta.recipient,0,0)
            ON CONFLICT (recipient_agent_id) DO NOTHING;
        UPDATE ot.project_dead_letter_counts
           SET open_count = open_count + delta.opened,
               dropped_count = dropped_count + delta.dropped
         WHERE recipient_agent_id = delta.recipient;
        DELETE FROM ot.project_dead_letter_counts
         WHERE recipient_agent_id = delta.recipient AND open_count = 0 AND dropped_count = 0;
    END LOOP;
    RETURN NULL;
END;
$$;
CREATE TRIGGER mail_dead_letter_counts
    AFTER INSERT OR UPDATE OF state, extra, recipient_agent_id OR DELETE ON ot.mail
    FOR EACH ROW EXECUTE FUNCTION ot.maintain_dead_letter_counts();

-- Synthetic fixtures and explicit whole-table maintenance use TRUNCATE.
CREATE FUNCTION ot.reset_dead_letter_counts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    TRUNCATE ot.project_dead_letter_counts;
    RETURN NULL;
END;
$$;
CREATE TRIGGER mail_dead_letter_counts_truncate AFTER TRUNCATE ON ot.mail
    FOR EACH STATEMENT EXECUTE FUNCTION ot.reset_dead_letter_counts();
