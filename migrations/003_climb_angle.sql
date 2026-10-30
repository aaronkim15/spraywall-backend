-- 003_climb_angle.sql
-- Wall angle (degrees) the setter intends a climb for. Nullable: existing climbs have none.
ALTER TABLE climbs ADD COLUMN IF NOT EXISTS angle integer;
