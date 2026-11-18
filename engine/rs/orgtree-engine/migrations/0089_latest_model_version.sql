-- A seat's model version is LATEST or PINNED (USER 2026-11-18 m62f2d7627923: "all hires and all nodes start on
-- \"latest\" as their model version, which updates dynamically as new versions are released with updates. agents
-- pinned to a specific version never have that changed"). From 4.6.3 "latest" is stored as no model_version.
--
-- 4.5.10 to 4.6.2 wrote an explicit version for every hire that named none: Fable 5.2 (from 4.5.10), Sol and Astra
-- 6.2 (4.6.2). Those automatic pins cannot be told from chosen ones (the hire records do not keep the request), so
-- every pin equal to its tier's newest version becomes latest (USER 2026-11-18 m18f3444ac04f "Unpin them"). Such a
-- seat runs the same model as before; it follows the next release from then on. Every other pin stays, and seats
-- of every kind are covered (live, retired, knowledge bearers). The engine applies it once.
UPDATE ot.agents SET scope = scope - 'model_version'
 WHERE (tier = 'fable' AND scope->>'model_version' = '5.2')
    OR (tier IN ('sol', 'astra') AND scope->>'model_version' = '6.2');
