-- P03 WS4, part 3: transcript content for `material.transcript` (r7 §4.2).
-- WS4 range 0200-0299.
--
-- v6 DATA-PLACEMENT places the transcript projection in PostgreSQL; its real
-- physical form is P04's. P03 needs only what the strict read reads in its
-- one snapshot (bounded by `last` through the position index) and the cold
-- read's identity mint (r7 §4.2 "Side writes": an idempotent upsert keyed by
-- its natural identity, own short transaction, ON CONFLICT DO NOTHING, then
-- read back). Rows are synthetic fixture content in P03.
--
-- Growth classes:
--   transcript_entries     retained user history (per seat, appended).
--   transcript_identities  current entity-bound (one per seat).

CREATE TABLE transcript_entries (
    org_id        uuid        NOT NULL,
    principal_id  uuid        NOT NULL,
    seq           bigint      NOT NULL,
    role          text        COLLATE "C" NOT NULL,
    body          text        NOT NULL,
    at            timestamptz NOT NULL,
    CONSTRAINT transcript_entries_pk PRIMARY KEY (org_id, principal_id, seq),
    CONSTRAINT transcript_entries_agent_fk FOREIGN KEY (org_id, principal_id) REFERENCES agents (org_id, principal_id),
    CONSTRAINT transcript_entries_seq CHECK (seq > 0),
    CONSTRAINT transcript_entries_body_bounded CHECK (octet_length(body) <= 1048576)
);

-- The transcript identity a cold read mints (Q-M7): one per seat, the unique
-- key is the conflict detector for concurrent first readers.
CREATE TABLE transcript_identities (
    org_id         uuid        NOT NULL,
    principal_id   uuid        NOT NULL,
    transcript_id  uuid        NOT NULL,
    minted_at      timestamptz NOT NULL,
    CONSTRAINT transcript_identities_pk PRIMARY KEY (org_id, transcript_id),
    CONSTRAINT transcript_identities_agent_fk FOREIGN KEY (org_id, principal_id) REFERENCES agents (org_id, principal_id)
);
CREATE UNIQUE INDEX transcript_identities_seat ON transcript_identities (org_id, principal_id);

GRANT SELECT, INSERT, DELETE ON transcript_entries, transcript_identities TO orgtree_runtime;
GRANT SELECT ON transcript_entries, transcript_identities TO orgtree_repl;
