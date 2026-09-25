-- P03 WS4, part 2: the reservation fields the base table lacks (r7 §3.2).
-- WS4 range 0200-0299. Adds columns only.
--
-- Legacy records `recovered_by` and `landed_at` on the row (reservations.py
-- `recover`, `acquire`'s inline recovery, `land`); the projection returns
-- both. `recovered_by` is the recovering PRINCIPAL (D3: identities, rendered
-- by the current name).
ALTER TABLE resource_reservations ADD COLUMN recovered_by uuid NULL;
ALTER TABLE resource_reservations ADD CONSTRAINT resource_reservations_recovered_by_fk
    FOREIGN KEY (org_id, recovered_by) REFERENCES agents (org_id, principal_id);
ALTER TABLE resource_reservations ADD COLUMN landed_at timestamptz NULL;
-- The owner's NAME when the claim was taken: legacy's stored `owner` string.
-- Ownership is the principal (D3); this label is read only by Q-R9's unsafe
-- control (name-bound ownership) and by the P04 migration audit, never by
-- an owner check.
ALTER TABLE resource_reservations ADD COLUMN owner_label text COLLATE "C" NULL;
ALTER TABLE resource_reservations ADD CONSTRAINT resource_reservations_owner_label_len
    CHECK (owner_label IS NULL OR octet_length(owner_label) <= 200);
