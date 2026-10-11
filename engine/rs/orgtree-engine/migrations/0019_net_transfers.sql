-- Private transport state. Messages stay queued until every attachment is complete.
CREATE TABLE ot.net_transfers (
    id text PRIMARY KEY,
    org_id bigint NOT NULL REFERENCES ot.orgs(id) ON DELETE CASCADE,
    inbox_id bigint NOT NULL REFERENCES ot.org_inbox(id) ON DELETE CASCADE,
    file_no integer NOT NULL CHECK (file_no >= 0),
    hub text NOT NULL,
    address text NOT NULL,
    source jsonb NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN
        ('queued','preparing','uploading','confirming','retry_wait','paused','complete','failed','cancelled','removed')),
    total bigint NOT NULL CHECK (total >= 0),
    processed bigint NOT NULL DEFAULT 0 CHECK (processed >= 0),
    confirmed bigint NOT NULL DEFAULT 0 CHECK (confirmed >= 0),
    session_id text,
    sha256 text,
    result_id text,
    error text,
    attempt integer NOT NULL DEFAULT 0,
    next_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (inbox_id, file_no)
);
CREATE INDEX net_transfers_due ON ot.net_transfers(next_at, updated_at)
    WHERE state IN ('queued','retry_wait');
CREATE INDEX org_inbox_queued_peer ON ot.org_inbox(org_id,peer,id)
    WHERE dir='out' AND state='queued';

-- Custody is persisted here before hub ACK. No visible inbox or agent mail yet.
CREATE TABLE ot.net_incoming (
    id text PRIMARY KEY,
    org_id bigint NOT NULL REFERENCES ot.orgs(id) ON DELETE CASCADE,
    hub text NOT NULL,
    address text NOT NULL,
    net_id text NOT NULL,
    envelope jsonb NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','downloading','delivering','retry_wait','failed','cancelled','complete')),
    attempt integer NOT NULL DEFAULT 0,
    error text,
    next_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(org_id,net_id)
);
CREATE INDEX net_incoming_due ON ot.net_incoming(next_at,created_at) WHERE state IN ('queued','retry_wait');
CREATE TABLE ot.net_downloads (
    id text PRIMARY KEY,
    incoming_id text NOT NULL REFERENCES ot.net_incoming(id) ON DELETE CASCADE,
    file_no integer NOT NULL,
    route jsonb NOT NULL,
    name text NOT NULL,
    path text NOT NULL,
    body boolean NOT NULL DEFAULT false,
    total bigint CHECK (total >= 0),
    processed bigint NOT NULL DEFAULT 0 CHECK (processed >= 0),
    confirmed bigint NOT NULL DEFAULT 0 CHECK (confirmed >= 0),
    validator text,
    complete boolean NOT NULL DEFAULT false,
    restart_reason text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(incoming_id,file_no)
);

ALTER TABLE ot.net_transfers ADD COLUMN cancelled_by text;
ALTER TABLE ot.net_incoming ADD COLUMN cancelled_by text;
-- One open failure episode per message; notification mail and notified_at
-- commit together. Resolved episodes remain as audit history.
CREATE TABLE ot.net_transfer_failures (
    id text PRIMARY KEY,
    org_id bigint NOT NULL REFERENCES ot.orgs(id) ON DELETE CASCADE,
    message_key text NOT NULL,
    detail jsonb NOT NULL,
    resolved boolean NOT NULL DEFAULT false,
    notified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX net_transfer_failure_open ON ot.net_transfer_failures(message_key) WHERE NOT resolved;
CREATE INDEX net_transfer_failure_pending ON ot.net_transfer_failures(created_at) WHERE notified_at IS NULL;

CREATE INDEX net_incoming_peer_pending ON ot.net_incoming(org_id,hub,(envelope->>'from'),created_at,id) WHERE state<>'complete';

-- Browser-to-engine staging is separate from message transport. Only complete
-- tickets have an ot.uploads row and can be attached to an outgoing message.
CREATE TABLE ot.upload_stages (
    id text PRIMARY KEY,
    org_id bigint NOT NULL REFERENCES ot.orgs(id) ON DELETE CASCADE,
    name text NOT NULL,
    path text NOT NULL,
    total bigint NOT NULL CHECK (total >= 0),
    received bigint NOT NULL DEFAULT 0,
    state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','uploading','complete','failed','cancelled')),
    error text,
    draft text NOT NULL DEFAULT '',
    hidden boolean NOT NULL DEFAULT false,
    cleaned_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upload_stage_cleanup ON ot.upload_stages(id) WHERE state IN ('queued','uploading') OR (state IN ('failed','cancelled') AND cleaned_at IS NULL);
CREATE INDEX upload_stage_saved ON ot.upload_stages(org_id,id) WHERE NOT hidden;
