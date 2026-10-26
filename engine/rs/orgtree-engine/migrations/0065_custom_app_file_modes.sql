-- Existing read grants keep their meaning. Portable definitions carry none.
ALTER TABLE ot.custom_app_file_grants ADD COLUMN mode text NOT NULL DEFAULT 'read' CHECK (mode IN ('read','write'));
ALTER TABLE ot.custom_app_file_grants DROP CONSTRAINT custom_app_file_grants_scope_check;
ALTER TABLE ot.custom_app_file_grants DROP CONSTRAINT custom_app_file_grants_check;
ALTER TABLE ot.custom_app_file_grants ADD CHECK (scope IN ('orgtree','file','folder','computer'));
ALTER TABLE ot.custom_app_file_grants ADD CHECK ((scope IN ('orgtree','computer') AND path IS NULL) OR (scope IN ('file','folder') AND path IS NOT NULL));
