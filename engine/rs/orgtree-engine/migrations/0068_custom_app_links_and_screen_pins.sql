-- Panel links were removed (user 2026-10-26): agents hear from a panel only
-- through app event listeners. The column stays so an older build can still
-- read its rows, but no stored link remains.
UPDATE ot.custom_panels SET linked_agents='[]'::jsonb WHERE linked_agents<>'[]'::jsonb;
-- Screen pins were removed (user 2026-10-26): a panel pinned to the screen
-- reopens as the centered window. Canvas pins and pop-outs keep their place.
UPDATE ot.custom_panels SET placement=jsonb_set(placement,'{mode}','"float"'),rev=rev+1,updated_at=now()
  WHERE placement->>'mode'='screen';
