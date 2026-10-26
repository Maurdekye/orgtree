-- The panel pin pins to the window (user 2026-10-26: "i meant pin it to the
-- window like other pinned panels") and canvas pins were removed ("Remove
-- canvas pinning"): a panel pinned to the canvas reopens as the centered
-- window and no longer attaches to a node. Window pins and pop-outs keep
-- their place.
UPDATE ot.custom_panels SET placement=placement||'{"mode":"float","anchor":null}'::jsonb,rev=rev+1,updated_at=now()
  WHERE placement->>'mode'='canvas' OR coalesce(placement->>'anchor','')<>'';
