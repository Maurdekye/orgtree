-- Several people on one organization (decision 103; docs/rust-engine/remote-org.md). Every connected desktop
-- is the user, and the records keep saying so ('@user', "user"). Beside them the engine now keeps which
-- computer a user action came through: `via` is the origin the request guard resolved from the token that
-- authenticated the request, {"id", "name"} and "on" when the client's own name says more than its label.
-- The name is the label as it was then, so a record stays readable after a rename or a revocation.
--
-- NULL on everything recorded before this, on what agents and the engine do, and on a user action that came
-- through no request. Nothing is backfilled, and nothing is derived from these columns: they are shown.
--
-- IF NOT EXISTS: until 2026-11-13 this file was 0086_user_origin on the 4.6.0 line, a number that 4.5.12
-- then shipped for another migration. A database that a 4.6.0 development build opened recorded that
-- name and already has these columns: there these statements change nothing.
ALTER TABLE ot.mail ADD COLUMN IF NOT EXISTS via jsonb;
ALTER TABLE ot.events ADD COLUMN IF NOT EXISTS via jsonb;
ALTER TABLE ot.work_events ADD COLUMN IF NOT EXISTS via jsonb;
ALTER TABLE ot.undo_entries ADD COLUMN IF NOT EXISTS via jsonb;
-- who settled a request (answered or dismissed it)
ALTER TABLE ot.asks ADD COLUMN IF NOT EXISTS answered_via jsonb;
