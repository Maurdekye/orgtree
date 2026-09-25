-- P03 WS2 base schema, part 5: mail base (S3 E1, v6 SCHEMA-CATALOG:14-15).
-- WS5 owns the semantics and may extend these tables in its own migration
-- range. The Sent stub (engine/native/store/src/sent.rs) writes ONLY
-- mail_sent and outgoing_intents: never a receiver row (v6 I07).

-- The mailbox HEAD row (C2a pair P8): one per mailbox incarnation. Every
-- receive into the mailbox, including every system notice, updates it.
-- The human mailbox has no head ordering (E-D3): owner_kind = 'user' rows
-- exist for identity only and are never locked by a receive.
CREATE TABLE mailboxes (
    org_id          uuid        NOT NULL,
    mailbox_id      uuid        NOT NULL,
    owner_kind      text        COLLATE "C" NOT NULL,
    owner_id        uuid        NULL,
    incarnation     bigint      NOT NULL DEFAULT 1,
    state           text        COLLATE "C" NOT NULL DEFAULT 'open',
    recv_seq        bigint      NOT NULL DEFAULT 0,
    version         bigint      NOT NULL DEFAULT 0,
    CONSTRAINT mailboxes_pk PRIMARY KEY (org_id, mailbox_id),
    CONSTRAINT mailboxes_owner_fk FOREIGN KEY (org_id, owner_id) REFERENCES agents (org_id, principal_id),
    CONSTRAINT mailboxes_owner_kind CHECK (owner_kind IN ('agent', 'user')),
    CONSTRAINT mailboxes_owner_shape CHECK ((owner_kind = 'agent') = (owner_id IS NOT NULL)),
    CONSTRAINT mailboxes_state CHECK (state IN ('open', 'closed')),
    CONSTRAINT mailboxes_recv_seq CHECK (recv_seq >= 0)
);
CREATE UNIQUE INDEX mailboxes_one_user_mailbox ON mailboxes (org_id) WHERE owner_kind = 'user';
CREATE UNIQUE INDEX mailboxes_by_owner ON mailboxes (org_id, owner_id, incarnation) WHERE owner_kind = 'agent';

-- Source-owned Sent row (E1.1 step 6). pair_seq is set for paired sources
-- (an agent, or the user) and NULL for SYSTEM (E1.2 "Sources").
CREATE TABLE mail_sent (
    org_id               uuid        NOT NULL,
    message_id           uuid        NOT NULL,
    source_kind          text        COLLATE "C" NOT NULL,
    source_id            uuid        NOT NULL,
    dest_kind            text        COLLATE "C" NOT NULL,
    dest_mailbox_id      uuid        NULL,
    dest_principal_id    uuid        NULL,
    dest_mailbox_incarnation bigint  NULL,
    dest_external        text        NULL,
    pair_seq             bigint      NULL,
    kind                 text        COLLATE "C" NOT NULL,
    urgent               boolean     NOT NULL DEFAULT false,
    body                 text        NOT NULL,
    fingerprint          text        COLLATE "C" NOT NULL,
    op_receipt_id        uuid        NULL,
    sent_at              timestamptz NOT NULL,
    CONSTRAINT mail_sent_pk PRIMARY KEY (org_id, message_id),
    CONSTRAINT mail_sent_org_fk FOREIGN KEY (org_id) REFERENCES organizations (org_id),
    CONSTRAINT mail_sent_dest_mailbox_fk FOREIGN KEY (org_id, dest_mailbox_id) REFERENCES mailboxes (org_id, mailbox_id),
    CONSTRAINT mail_sent_source_kind CHECK (source_kind IN ('agent', 'user', 'system')),
    CONSTRAINT mail_sent_dest_kind CHECK (dest_kind IN ('mailbox', 'external')),
    CONSTRAINT mail_sent_dest_shape CHECK (
        (dest_kind = 'mailbox' AND dest_mailbox_id IS NOT NULL AND dest_external IS NULL)
        OR (dest_kind = 'external' AND dest_mailbox_id IS NULL AND dest_external IS NOT NULL)),
    CONSTRAINT mail_sent_pair_shape CHECK ((source_kind = 'system') = (pair_seq IS NULL) OR dest_kind = 'external'),
    CONSTRAINT mail_sent_pair_positive CHECK (pair_seq IS NULL OR pair_seq > 0),
    CONSTRAINT mail_sent_body_bounded CHECK (octet_length(body) <= 1048576)
);
-- E-D1: the pair-order conflict detector (on the executor's retry allowlist).
CREATE UNIQUE INDEX mail_sent_pair_seq
    ON mail_sent (org_id, source_kind, source_id, dest_mailbox_id, pair_seq)
    WHERE pair_seq IS NOT NULL;

-- Per (destination mailbox, source) receive high-water (E1.2, N5): its own
-- row, taken FOR NO KEY UPDATE by every paired receive.
CREATE TABLE mail_pair_highwater (
    org_id       uuid   NOT NULL,
    mailbox_id   uuid   NOT NULL,
    source_kind  text   COLLATE "C" NOT NULL,
    source_id    uuid   NOT NULL,
    high_seq     bigint NOT NULL DEFAULT 0,
    CONSTRAINT mail_pair_highwater_pk PRIMARY KEY (org_id, mailbox_id, source_kind, source_id),
    CONSTRAINT mail_pair_highwater_mailbox_fk FOREIGN KEY (org_id, mailbox_id) REFERENCES mailboxes (org_id, mailbox_id),
    CONSTRAINT mail_pair_highwater_nonneg CHECK (high_seq >= 0)
);

-- Receiver-owned rows (E1.3). Dedupe key = (mailbox, original message id).
CREATE TABLE mailbox_messages (
    org_id               uuid        NOT NULL,
    mailbox_id           uuid        NOT NULL,
    original_message_id  uuid        NOT NULL,
    recv_ord             bigint      NULL,
    fingerprint          text        COLLATE "C" NOT NULL,
    state                text        COLLATE "C" NOT NULL,
    is_notice            boolean     NOT NULL DEFAULT false,
    received_at          timestamptz NOT NULL,
    read_at              timestamptz NULL,
    CONSTRAINT mailbox_messages_original PRIMARY KEY (org_id, mailbox_id, original_message_id),
    CONSTRAINT mailbox_messages_mailbox_fk FOREIGN KEY (org_id, mailbox_id) REFERENCES mailboxes (org_id, mailbox_id),
    CONSTRAINT mailbox_messages_state CHECK (state IN ('pending', 'delivered', 'read', 'retracted', 'refused', 'cancelled'))
);
CREATE UNIQUE INDEX mailbox_messages_recv_ord ON mailbox_messages (org_id, mailbox_id, recv_ord)
    WHERE recv_ord IS NOT NULL;
CREATE INDEX mailbox_messages_pending ON mailbox_messages (org_id, mailbox_id) WHERE state = 'pending';

-- Causal intents committed with the source transaction; drained by their
-- owners after commit (delivery, wake, kickoff, transport).
CREATE TABLE outgoing_intents (
    org_id          uuid        NOT NULL,
    intent_id       uuid        NOT NULL,
    kind            text        COLLATE "C" NOT NULL,
    source_ref      uuid        NOT NULL,
    dest_ref        uuid        NULL,
    stage           text        COLLATE "C" NOT NULL DEFAULT 'pending',
    attempts        integer     NOT NULL DEFAULT 0,
    due_at          timestamptz NOT NULL,
    created_at      timestamptz NOT NULL,
    settled_at      timestamptz NULL,
    CONSTRAINT outgoing_intents_pk PRIMARY KEY (org_id, intent_id),
    CONSTRAINT outgoing_intents_org_fk FOREIGN KEY (org_id) REFERENCES organizations (org_id),
    CONSTRAINT outgoing_intents_kind CHECK (kind IN ('mail.deliver', 'mail.retract', 'wake', 'kickoff', 'notify', 'folder.move')),
    CONSTRAINT outgoing_intents_stage CHECK (stage IN ('pending', 'settled', 'refused', 'dormant')),
    CONSTRAINT outgoing_intents_unique_effect UNIQUE (org_id, kind, source_ref, dest_ref)
);
CREATE INDEX outgoing_intents_due ON outgoing_intents (org_id, due_at) WHERE stage = 'pending';

CREATE TABLE transport_intents (
    org_id       uuid        NOT NULL,
    intent_id    uuid        NOT NULL,
    message_id   uuid        NOT NULL,
    handle       text        COLLATE "C" NOT NULL,
    stage        text        COLLATE "C" NOT NULL DEFAULT 'pending',
    attempts     integer     NOT NULL DEFAULT 0,
    due_at       timestamptz NOT NULL,
    result       jsonb       NULL,
    CONSTRAINT transport_intents_pk PRIMARY KEY (org_id, intent_id),
    CONSTRAINT transport_intents_message_fk FOREIGN KEY (org_id, message_id) REFERENCES mail_sent (org_id, message_id),
    CONSTRAINT transport_intents_stage CHECK (stage IN ('pending', 'sent', 'uncertain', 'refused')),
    CONSTRAINT transport_intents_unique_effect UNIQUE (org_id, message_id, handle)
);
