-- 004_seed_wall.sql
-- The frontend uses one fixed wall id (WALL_ID in spraywall-web/src/config.ts).
-- Nothing else creates a wall, so a fresh database needs this row before the
-- photo can be uploaded or climbs created. ON CONFLICT makes it safe to re-run.
INSERT INTO walls (id, name)
VALUES ('a99a7ad1-834a-4770-99d3-2904f08dcca8', 'Spray Wall')
ON CONFLICT (id) DO NOTHING;
