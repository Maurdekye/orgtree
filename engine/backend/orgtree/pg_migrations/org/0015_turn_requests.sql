-- Durable org half of turn admission. App identities have no cross-database FK.
CREATE TABLE orgtree.turn_requests (
  request_id uuid PRIMARY KEY,
  agent_id bigint NOT NULL REFERENCES orgtree.agents(id),
  reason text NOT NULL CHECK (reason <> ''),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'queued', 'running', 'stopping', 'done', 'cancelled', 'lost')),
  claim_epoch bigint NOT NULL DEFAULT 0 CHECK (claim_epoch >= 0),
  lease_owner bigint NOT NULL CHECK (lease_owner > 0),
  claim_token uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  stopped_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  -- A committed org transition still needs its idempotent app half. Clear
  -- only after confirming the same state and epoch; a concurrent cancel wins.
  app_pending boolean NOT NULL DEFAULT false,
  CHECK ((state IN ('done', 'cancelled', 'lost')) = (ended_at IS NOT NULL)),
  CHECK (state NOT IN ('running', 'stopping', 'done') OR
         (claim_epoch > 0 AND claim_token IS NOT NULL AND started_at IS NOT NULL))
);

CREATE UNIQUE INDEX turn_requests_one_open ON orgtree.turn_requests (agent_id)
  WHERE state IN ('pending', 'queued', 'running', 'stopping');
CREATE INDEX turn_requests_forward ON orgtree.turn_requests (created_at, request_id)
  WHERE app_pending;
CREATE INDEX turn_requests_pending ON orgtree.turn_requests (created_at, request_id)
  WHERE state = 'pending';
CREATE INDEX turn_requests_owner ON orgtree.turn_requests (lease_owner, request_id)
  WHERE state IN ('pending', 'queued', 'running', 'stopping');
CREATE INDEX jobs_start_turn_due ON orgtree.jobs (run_at, id)
  WHERE kind = 'start_turn' AND state = 'queued';
CREATE INDEX jobs_start_turn_expired ON orgtree.jobs (lease_until, id)
  WHERE kind = 'start_turn' AND state = 'running';
