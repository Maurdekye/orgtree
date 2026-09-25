-- P03 WS5, part 1: mail semantics on the WS2 mail base (S3 E1, §4.5-4.7).
-- WS5 range 0300-0399 (CONTRACT-M1 §7). Adds only columns, constraints and
-- tables; renames nothing a consumer relies on.
--
-- Growth classes (v6 SCHEMA-CATALOG "Growth and query contracts"):
--   mail_sent, mailbox_messages  retained user/resource history. Receiver rows
--                                include `folded` notice tombstones and
--                                `refused`/`cancelled` fences, which keep the
--                                dedupe key fencing late redelivery. Removed
--                                only by the mailbox's own delete (legacy
--                                erase); retention is P06's. WS8 reports
--                                growth in churn-then-settle.
--   mail_input_batches           temporary-to-settle: one open batch per
--                                mailbox, settled on confirm or abandon;
--                                cleanup of settled rows is P08's.
--   extern_handles               current entity-bound (dies with its agent).
--   seat_session_facts           current entity-bound (one row per seat).
--   runtime_command_intents      temporary-to-settle: settled or refused by
--                                the runtime (P08); cleanup is P08's.

-- The mail class (CONTRACT-M1 §8 r5, lead ack A1): 'message' wakes the
-- recipient; 'passive' is an agent's explicit notice (in mail, no wake);
-- 'notice' is a system notice filed into the seat's notice box (no wake, no
-- lifecycle read, foldable; already read in the human mailbox).
ALTER TABLE mail_sent ADD COLUMN class text COLLATE "C" NOT NULL DEFAULT 'message';
ALTER TABLE mail_sent ADD CONSTRAINT mail_sent_class CHECK (class IN ('message', 'passive', 'notice'));
-- D-169: urgent carries its reason; both only on mail to the user.
ALTER TABLE mail_sent ADD COLUMN urgent_reason text NULL;
ALTER TABLE mail_sent ADD CONSTRAINT mail_sent_urgent_reason CHECK (urgent = (urgent_reason IS NOT NULL));
-- A held-handle outside send is attributed to its sender (v6 matrix row
-- "Agent to its exact held external handle").
ALTER TABLE mail_sent ADD COLUMN attributed boolean NOT NULL DEFAULT false;
-- v6 "Identity ... common to every variant": the captured display label of
-- the resolved destination (its name at Sent time). Display only: delivery
-- is keyed on the captured principal and mailbox, never on this label.
ALTER TABLE mail_sent ADD COLUMN dest_label text COLLATE "C" NULL;
-- The pair rule is DERIVED (lead ack A1 condition 2): pair_seq is set iff the
-- source is an agent or the user, the class is message or passive, and the
-- destination is a mailbox. It replaces WS2's mail_sent_pair_shape, which
-- predates the class and would refuse an agent's or the user's notice.
ALTER TABLE mail_sent DROP CONSTRAINT mail_sent_pair_shape;
ALTER TABLE mail_sent ADD CONSTRAINT mail_sent_pair_rule CHECK (
    (pair_seq IS NOT NULL) = (source_kind IN ('agent', 'user') AND class IN ('message', 'passive') AND dest_kind = 'mailbox'));

-- The transport executor's fenced dispatch claim (v6 "Agent to outside
-- party"): a fresh token per claim; a settle must present the current one.
ALTER TABLE transport_intents ADD COLUMN claim_token uuid NULL;

-- Receiver rows copy the captured delegation facts they display (v6: the
-- receiver reads its captured delegation, never the sender's current state),
-- so reads need no join to source rows. Digest rows are receiver-created and
-- have no Sent row. States add 'delivering' (claimed by a runtime input
-- batch, not yet confirmed: Q-IB3's "in flight") and 'folded' (a notice kept
-- as a tombstone inside a digest, so its dedupe key still fences a late
-- redelivery; S3 §8 leaves the notice box's physical form open).
ALTER TABLE mailbox_messages ADD COLUMN class text COLLATE "C" NULL;
ALTER TABLE mailbox_messages ADD COLUMN kind text COLLATE "C" NULL;
ALTER TABLE mailbox_messages ADD COLUMN source_kind text COLLATE "C" NULL;
ALTER TABLE mailbox_messages ADD COLUMN source_id uuid NULL;
ALTER TABLE mailbox_messages ADD COLUMN pair_seq bigint NULL;
ALTER TABLE mailbox_messages ADD COLUMN sent_at timestamptz NULL;
ALTER TABLE mailbox_messages ADD COLUMN urgent boolean NOT NULL DEFAULT false;
ALTER TABLE mailbox_messages ADD COLUMN batch_id uuid NULL;
ALTER TABLE mailbox_messages ADD COLUMN delivered_at timestamptz NULL;
ALTER TABLE mailbox_messages ADD COLUMN folded_into uuid NULL;
ALTER TABLE mailbox_messages ADD COLUMN digest jsonb NULL;
ALTER TABLE mailbox_messages DROP CONSTRAINT mailbox_messages_state;
ALTER TABLE mailbox_messages ADD CONSTRAINT mailbox_messages_state_v2 CHECK (state IN (
    'pending', 'delivering', 'delivered', 'read', 'retracted', 'refused', 'cancelled', 'folded'));
ALTER TABLE mailbox_messages ADD CONSTRAINT mailbox_messages_class CHECK (class IS NULL OR class IN ('message', 'passive', 'notice'));
ALTER TABLE mailbox_messages ADD CONSTRAINT mailbox_messages_batch_shape CHECK ((state = 'delivering') = (batch_id IS NOT NULL));
ALTER TABLE mailbox_messages ADD CONSTRAINT mailbox_messages_folded_shape CHECK ((state = 'folded') = (folded_into IS NOT NULL));
-- The human mailbox's display order is (Sent time, message id) (E-D3).
CREATE INDEX mailbox_messages_by_sent ON mailbox_messages (org_id, mailbox_id, sent_at, original_message_id);
CREATE INDEX mailbox_messages_by_batch ON mailbox_messages (org_id, batch_id) WHERE batch_id IS NOT NULL;

-- Runtime input batches (v6 input_batches; S3 §4.7 "claimed by a runtime
-- input batch but not yet confirmed"). A batch belongs to one runtime claim;
-- confirmation by matching fake-provider input evidence marks its rows
-- delivered (v6 MAIL-STAGES "Read").
CREATE TABLE mail_input_batches (
    org_id        uuid        NOT NULL,
    batch_id      uuid        NOT NULL,
    mailbox_id    uuid        NOT NULL,
    principal_id  uuid        NOT NULL,
    generation    bigint      NOT NULL,
    claim_id      uuid        NOT NULL,
    state         text        COLLATE "C" NOT NULL,
    evidence      text        COLLATE "C" NULL,
    created_at    timestamptz NOT NULL,
    settled_at    timestamptz NULL,
    CONSTRAINT mail_input_batches_pk PRIMARY KEY (org_id, batch_id),
    CONSTRAINT mail_input_batches_mailbox_fk FOREIGN KEY (org_id, mailbox_id) REFERENCES mailboxes (org_id, mailbox_id),
    CONSTRAINT mail_input_batches_agent_fk FOREIGN KEY (org_id, principal_id) REFERENCES agents (org_id, principal_id),
    CONSTRAINT mail_input_batches_state CHECK (state IN ('claimed', 'confirmed', 'abandoned'))
);
CREATE UNIQUE INDEX mail_input_batches_one_open ON mail_input_batches (org_id, mailbox_id) WHERE state = 'claimed';

-- Exact external-handle bindings (legacy hire-time `external_handles`): a
-- node holding this exact address answers it from any depth, attributed,
-- without the org-inbox (EXTERN) audience.
CREATE TABLE extern_handles (
    org_id        uuid NOT NULL,
    principal_id  uuid NOT NULL,
    handle        text COLLATE "C" NOT NULL,
    CONSTRAINT extern_handles_pk PRIMARY KEY (org_id, principal_id, handle),
    CONSTRAINT extern_handles_agent_fk FOREIGN KEY (org_id, principal_id) REFERENCES agents (org_id, principal_id),
    CONSTRAINT extern_handles_handle_len CHECK (octet_length(handle) BETWEEN 1 AND 400)
);

-- The seat facts the session-command refusals read (S3 §4.6: frozen,
-- remote-controlled, knowledge bearer, no conversation, just compacted).
-- SCHEDULE-GRADE stand-in for P08's runtime state: written by the harness
-- and read by the human session command without a lock (as legacy's
-- pre-check). A seat with no row has every flag false and a conversation.
CREATE TABLE seat_session_facts (
    org_id             uuid    NOT NULL,
    principal_id       uuid    NOT NULL,
    frozen             boolean NOT NULL DEFAULT false,
    remote_controlled  boolean NOT NULL DEFAULT false,
    knowledge_bearer   boolean NOT NULL DEFAULT false,
    has_conversation   boolean NOT NULL DEFAULT true,
    just_compacted     boolean NOT NULL DEFAULT false,
    version            bigint  NOT NULL DEFAULT 0,
    CONSTRAINT seat_session_facts_pk PRIMARY KEY (org_id, principal_id),
    CONSTRAINT seat_session_facts_agent_fk FOREIGN KEY (org_id, principal_id) REFERENCES agents (org_id, principal_id)
);

-- A human session command accepted by its source transaction (S3 §4.6):
-- the runtime (P08) runs it after commit and settles the row.
CREATE TABLE runtime_command_intents (
    org_id        uuid        NOT NULL,
    intent_id     uuid        NOT NULL,
    principal_id  uuid        NOT NULL,
    command       text        COLLATE "C" NOT NULL,
    args          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    state         text        COLLATE "C" NOT NULL DEFAULT 'pending',
    created_at    timestamptz NOT NULL,
    settled_at    timestamptz NULL,
    CONSTRAINT runtime_command_intents_pk PRIMARY KEY (org_id, intent_id),
    CONSTRAINT runtime_command_intents_agent_fk FOREIGN KEY (org_id, principal_id) REFERENCES agents (org_id, principal_id),
    CONSTRAINT runtime_command_intents_state CHECK (state IN ('pending', 'settled', 'refused')),
    CONSTRAINT runtime_command_intents_args_bounded CHECK (octet_length(args::text) <= 65536)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON mail_input_batches, extern_handles, seat_session_facts, runtime_command_intents TO orgtree_runtime;
GRANT SELECT ON mail_input_batches, extern_handles, seat_session_facts, runtime_command_intents TO orgtree_repl;
