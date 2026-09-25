-- P03 WS2 base schema, part 6: request batches, charters, minimal runtime
-- claims and folder-move intents (v6 SCHEMA-CATALOG:11,13,16; S3 §8).

-- Asks, credit requests and scope requests. Filing any of them bumps the
-- asker's authority_epoch.requests_version (r7 C2a P7).
CREATE TABLE request_batches (
    org_id       uuid        NOT NULL,
    batch_id     uuid        NOT NULL,
    asker_id     uuid        NOT NULL,
    kind         text        COLLATE "C" NOT NULL,
    state        text        COLLATE "C" NOT NULL,
    rev          bigint      NOT NULL DEFAULT 1,
    payload      jsonb       NOT NULL,
    result       jsonb       NULL,
    created_at   timestamptz NOT NULL,
    decided_at   timestamptz NULL,
    CONSTRAINT request_batches_pk PRIMARY KEY (org_id, batch_id),
    CONSTRAINT request_batches_asker_fk FOREIGN KEY (org_id, asker_id) REFERENCES agents (org_id, principal_id),
    CONSTRAINT request_batches_kind CHECK (kind IN ('ask', 'credit', 'scope')),
    CONSTRAINT request_batches_state CHECK (state IN ('pending', 'answered', 'denied', 'withdrawn', 'moot', 'dismissed')),
    CONSTRAINT request_batches_payload_bounded CHECK (octet_length(payload::text) <= 262144)
);
-- One pending request per asker and kind (S3 §4.13, Q-FD2).
CREATE UNIQUE INDEX request_batches_one_pending
    ON request_batches (org_id, asker_id, kind) WHERE state = 'pending';

-- Charters: immutable versions, one head per principal (v6 §Charter).
CREATE TABLE charter_versions (
    org_id        uuid        NOT NULL,
    principal_id  uuid        NOT NULL,
    version       bigint      NOT NULL,
    body          text        NOT NULL,
    body_sha256   text        COLLATE "C" NOT NULL,
    saved_at      timestamptz NOT NULL,
    CONSTRAINT charter_versions_pk PRIMARY KEY (org_id, principal_id, version),
    CONSTRAINT charter_versions_agent_fk FOREIGN KEY (org_id, principal_id) REFERENCES agents (org_id, principal_id),
    CONSTRAINT charter_versions_version CHECK (version > 0),
    CONSTRAINT charter_versions_body_bounded CHECK (octet_length(body) <= 1048576)
);

CREATE TABLE charter_heads (
    org_id          uuid   NOT NULL,
    principal_id    uuid   NOT NULL,
    current_version bigint NOT NULL,
    CONSTRAINT charter_heads_pk PRIMARY KEY (org_id, principal_id),
    CONSTRAINT charter_heads_version_fk FOREIGN KEY (org_id, principal_id, current_version)
        REFERENCES charter_versions (org_id, principal_id, version)
);

-- Minimal runtime claims (WS5 scope: mail Read confirmation, kickoff and
-- wake admission). The full runtime is P08.
CREATE TABLE runtime_claims (
    org_id        uuid        NOT NULL,
    claim_id      uuid        NOT NULL,
    principal_id  uuid        NOT NULL,
    generation    bigint      NOT NULL,
    turn_id       uuid        NOT NULL,
    state         text        COLLATE "C" NOT NULL,
    charter_vector jsonb      NULL,
    created_at    timestamptz NOT NULL,
    settled_at    timestamptz NULL,
    CONSTRAINT runtime_claims_pk PRIMARY KEY (org_id, claim_id),
    CONSTRAINT runtime_claims_agent_fk FOREIGN KEY (org_id, principal_id) REFERENCES agents (org_id, principal_id),
    CONSTRAINT runtime_claims_state CHECK (state IN ('admitted', 'active', 'settling', 'settled', 'deferred', 'refused'))
);
-- one active execution per seat (v6 SCHEMA-CATALOG:13, current product contract)
CREATE UNIQUE INDEX runtime_claims_one_active
    ON runtime_claims (org_id, principal_id) WHERE state IN ('admitted', 'active', 'settling');

-- Folder-move intents for a rename (S3 E-D11/E-D19). One pending per stack.
CREATE TABLE folder_move_intents (
    org_id        uuid        NOT NULL,
    intent_id     uuid        NOT NULL,
    stack_root_id uuid        NOT NULL,
    path_kind     text        COLLATE "C" NOT NULL,
    old_name      text        COLLATE "C" NOT NULL,
    new_name      text        COLLATE "C" NOT NULL,
    state         text        COLLATE "C" NOT NULL,
    created_at    timestamptz NOT NULL,
    settled_at    timestamptz NULL,
    CONSTRAINT folder_move_intents_pk PRIMARY KEY (org_id, intent_id),
    CONSTRAINT folder_move_intents_stack_fk FOREIGN KEY (org_id, stack_root_id) REFERENCES agents (org_id, principal_id),
    CONSTRAINT folder_move_intents_path CHECK (path_kind IN ('A', 'L')),
    CONSTRAINT folder_move_intents_state CHECK (state IN ('pending', 'completed', 'undone', 'unsettled'))
);
CREATE UNIQUE INDEX folder_move_intents_one_pending
    ON folder_move_intents (org_id, stack_root_id) WHERE state = 'pending';
