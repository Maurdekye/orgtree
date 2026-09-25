-- P03 WS2 base schema, part 8: role grants.
-- Roles are created by the WS1 custodian: orgtree_admin (owner; runs the
-- migrations), orgtree_runtime (the store service: DML only, never DDL) and
-- orgtree_repl (REPLICATION; SELECT on published tables for the snapshot
-- export). PUBLIC has no rights on database `orgtree`.
--
-- Retention is part of the grant: tables that are append-only history, or
-- whose rows are never deleted by commands, get no DELETE (receipts are
-- retained, v6 §Receipt retention; Sent content is immutable, v6
-- TRANSACTIONS:38). Written by the custodian only: store_incarnation.

GRANT USAGE ON SCHEMA public TO orgtree_runtime, orgtree_repl;

-- full DML: current-state rows commands insert, update and delete
GRANT SELECT, INSERT, UPDATE, DELETE ON
    organizations, org_controls, agents, agent_names, authority_epoch,
    topology_edges, scope_rows, runtime_state, audience_grants,
    runtime_inflight, service_incarnations, read_service_registrations,
    restriction_obligations,
    catalog_current, issuer_capacity, funding_edges, kiosk_pool,
    work_items, work_participants, active_work_names,
    resource_reservations,
    mailboxes, mail_pair_highwater, mailbox_messages, outgoing_intents, transport_intents,
    request_batches, charter_heads, runtime_claims, folder_move_intents
TO orgtree_runtime;

-- retained: never deleted by a command
GRANT SELECT, INSERT, UPDATE ON operation_receipts, restrictions TO orgtree_runtime;

-- append-only history and immutable content
GRANT SELECT, INSERT ON work_item_versions, charter_versions, price_catalog, mail_sent TO orgtree_runtime;

-- read-only to the service
GRANT SELECT ON store_incarnation, legacy_work_names, publication_catalog TO orgtree_runtime;

-- the snapshot export reads exactly the published set (CONTRACT-M1 §7)
GRANT SELECT ON
    organizations, org_controls, agents, agent_names, authority_epoch,
    topology_edges, scope_rows, runtime_state, audience_grants,
    catalog_current, price_catalog, issuer_capacity, funding_edges, kiosk_pool,
    work_items, work_item_versions, work_participants, active_work_names,
    resource_reservations,
    mailboxes, mail_sent, mail_pair_highwater, mailbox_messages,
    outgoing_intents, transport_intents,
    request_batches, charter_heads, charter_versions, runtime_claims, folder_move_intents
TO orgtree_repl;
GRANT SELECT (org_id, ns_kind, ns_id, op_key, receipt_id, family, verb, state, decided_at)
    ON operation_receipts TO orgtree_repl;
