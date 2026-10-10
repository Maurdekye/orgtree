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
        ('queued','preparing','uploading','confirming','retry_wait','paused','complete','failed','cancelled')),
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
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','downloading','retry_wait','failed','cancelled','complete')),
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
