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
