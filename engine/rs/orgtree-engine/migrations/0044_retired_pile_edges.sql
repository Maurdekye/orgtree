-- The record feed's shared set carries each visible parent's retired-pile
-- representatives: its first and last archived child in the canvas's sibling
-- order (feed::compute::pile_edges). Each end is one probe of this index, so
-- the read is bounded by the live tree, not by how many agents have retired.
CREATE INDEX agents_retired_pile_edges ON ot.agents (org_id, parent_id, sibling_order, id)
    WHERE state = 'archived';
