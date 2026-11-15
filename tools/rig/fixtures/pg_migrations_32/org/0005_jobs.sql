-- Per-org background work (design 2.7). Finished history is absent from every
-- scheduling index. The database scopes the queue; no org_id belongs here.
CREATE TABLE orgtree.jobs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text NOT NULL CHECK (kind <> ''),
  agent_id     bigint REFERENCES orgtree.agents(id),
  item_id      bigint REFERENCES orgtree.work_items(id),
  watchdog_id  bigint REFERENCES orgtree.watchdogs(id),
  run_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  state        text NOT NULL DEFAULT 'queued'
               CHECK (state IN ('queued', 'running', 'done', 'failed')),
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  lease_owner  bigint CHECK (lease_owner > 0), -- app engine_instances.id; no cross-db FK
  lease_until  timestamptz,
  last_error   text,
  dedupe_key   text NOT NULL CHECK (dedupe_key <> ''),
  CHECK (attempts <= max_attempts),
  CHECK (state <> 'queued' OR attempts < max_attempts),
  CHECK ((state = 'running') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (state = 'running' OR (lease_owner IS NULL AND lease_until IS NULL))
);

CREATE INDEX jobs_due ON orgtree.jobs (run_at, id) WHERE state = 'queued';
CREATE INDEX jobs_expired ON orgtree.jobs (lease_until, id) WHERE state = 'running';
CREATE UNIQUE INDEX jobs_one_active ON orgtree.jobs (kind, dedupe_key)
  WHERE state IN ('queued', 'running');

-- Enqueue, retry, reschedule and release wake every scheduler of this org.
-- PostgreSQL delivers the notification only if the writer commits.
CREATE FUNCTION orgtree.jobs_notify() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM pg_notify('org_jobs', '');
  RETURN NEW;
END
$fn$;
CREATE TRIGGER jobs_notify AFTER INSERT OR UPDATE OF state, run_at ON orgtree.jobs
  FOR EACH ROW EXECUTE FUNCTION orgtree.jobs_notify();
