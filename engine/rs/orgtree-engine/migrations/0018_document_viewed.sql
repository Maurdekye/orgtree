-- The user's read state of presented documents lives in the engine, not only
-- in the desktop's localStorage (which a PC crash or a profile loss takes
-- with it): the `at` of the document as the user last opened it. NULL = never
-- opened (NEW); older than `at` = re-presented since (UPDATED).
ALTER TABLE ot.documents ADD COLUMN viewed_at timestamptz;
