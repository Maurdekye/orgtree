-- Several people on one organization (decision 101; docs/rust-engine/remote-org.md). Every connected desktop
-- is the user, and the records keep saying so ('@user', "user"). Beside them the engine now keeps which
-- computer a user action came through: `via` is the origin the request guard resolved from the token that
-- authenticated the request, {"id", "name"} and "on" when the client's own name says more than its label.
-- The name is the label as it was then, so a record stays readable after a rename or a revocation.
--
-- NULL on everything recorded before this, on what agents and the engine do, and on a user action that came
-- through no request. Nothing is backfilled, and nothing is derived from these columns: they are shown.
ALTER TABLE ot.mail ADD COLUMN via jsonb;
ALTER TABLE ot.events ADD COLUMN via jsonb;
ALTER TABLE ot.work_events ADD COLUMN via jsonb;
ALTER TABLE ot.undo_entries ADD COLUMN via jsonb;
-- who settled a request (answered or dismissed it)
ALTER TABLE ot.asks ADD COLUMN answered_via jsonb;
