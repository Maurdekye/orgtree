-- P03 WS2 base schema, part 3: work items (v6 SCHEMA-CATALOG:17-18, r7 C3).
-- Every writer of an item's owner, creator, reviewer, participant set or
-- open/closed/archived state updates the item's HEAD row (work_items) in the
-- same transaction (r7 C3); readers anchor that row.

CREATE TABLE work_items (
    org_id          uuid        NOT NULL,
    item_id         uuid        NOT NULL,
    name            text        COLLATE "C" NOT NULL,
    title           text        NOT NULL,
    kind            text        COLLATE "C" NOT NULL,
    status          text        COLLATE "C" NOT NULL,
    owner_id        uuid        NULL,
    creator_id      uuid        NULL,
    reviewer_id     uuid        NULL,
    parent_item_id  uuid        NULL,
    rev             bigint      NOT NULL DEFAULT 1,
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    archived_at     timestamptz NULL,
    CONSTRAINT work_items_pk PRIMARY KEY (org_id, item_id),
    CONSTRAINT work_items_org_fk FOREIGN KEY (org_id) REFERENCES organizations (org_id),
    CONSTRAINT work_items_owner_fk FOREIGN KEY (org_id, owner_id) REFERENCES agents (org_id, principal_id),
    CONSTRAINT work_items_creator_fk FOREIGN KEY (org_id, creator_id) REFERENCES agents (org_id, principal_id),
    CONSTRAINT work_items_reviewer_fk FOREIGN KEY (org_id, reviewer_id) REFERENCES agents (org_id, principal_id),
    CONSTRAINT work_items_parent_fk FOREIGN KEY (org_id, parent_item_id) REFERENCES work_items (org_id, item_id),
    CONSTRAINT work_items_kind CHECK (kind IN ('code', 'non-code')),
    CONSTRAINT work_items_status CHECK (status IN (
        'backlogged', 'open', 'in_progress', 'blocked', 'review', 'approved',
        'deploy_ready', 'done', 'dropped')),
    CONSTRAINT work_items_rev CHECK (rev > 0),
    CONSTRAINT work_items_title_len CHECK (char_length(title) BETWEEN 1 AND 200)
);
CREATE INDEX work_items_by_owner ON work_items (org_id, owner_id, status);
CREATE INDEX work_items_current ON work_items (org_id, status) WHERE archived_at IS NULL;

-- Append-only history: one row per scope version, decision, progress update.
CREATE TABLE work_item_versions (
    org_id        uuid        NOT NULL,
    item_id       uuid        NOT NULL,
    seq           bigint      NOT NULL,
    kind          text        COLLATE "C" NOT NULL,
    body          jsonb       NOT NULL,
    by_principal  uuid        NULL,
    at            timestamptz NOT NULL,
    CONSTRAINT work_item_versions_pk PRIMARY KEY (org_id, item_id, seq),
    CONSTRAINT work_item_versions_item_fk FOREIGN KEY (org_id, item_id) REFERENCES work_items (org_id, item_id),
    CONSTRAINT work_item_versions_seq CHECK (seq > 0)
);

CREATE TABLE work_participants (
    org_id        uuid NOT NULL,
    item_id       uuid NOT NULL,
    principal_id  uuid NOT NULL,
    role          text COLLATE "C" NOT NULL DEFAULT 'participant',
    CONSTRAINT work_participants_pk PRIMARY KEY (org_id, item_id, principal_id),
    CONSTRAINT work_participants_item_fk FOREIGN KEY (org_id, item_id) REFERENCES work_items (org_id, item_id),
    CONSTRAINT work_participants_agent_fk FOREIGN KEY (org_id, principal_id) REFERENCES agents (org_id, principal_id),
    CONSTRAINT work_participants_role CHECK (role IN ('participant'))
);
CREATE INDEX work_participants_by_principal ON work_participants (org_id, principal_id);

-- New names: always suffixed, canonical codec (work-name-codec), exact bytes.
CREATE TABLE active_work_names (
    org_id   uuid NOT NULL,
    name     text COLLATE "C" NOT NULL,
    item_id  uuid NOT NULL,
    CONSTRAINT active_work_names_pk PRIMARY KEY (org_id, name),
    CONSTRAINT active_work_names_item UNIQUE (org_id, item_id),
    CONSTRAINT active_work_names_item_fk FOREIGN KEY (org_id, item_id) REFERENCES work_items (org_id, item_id),
    CONSTRAINT active_work_names_len CHECK (octet_length(name) BETWEEN 1 AND 76)
);

-- Fixed legacy corpus: imported once, never written by live commands.
CREATE TABLE legacy_work_names (
    org_id   uuid    NOT NULL,
    name     text    COLLATE "C" NOT NULL,
    item_id  uuid    NULL,
    live     boolean NOT NULL,
    CONSTRAINT legacy_work_names_pk PRIMARY KEY (org_id, name),
    CONSTRAINT legacy_work_names_org_fk FOREIGN KEY (org_id) REFERENCES organizations (org_id)
);
