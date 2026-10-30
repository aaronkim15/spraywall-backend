-- 002_wall_display_image.sql
-- Cached downscaled wall photo (~1600px) for fast display; full-res stays in image_data.
ALTER TABLE walls ADD COLUMN IF NOT EXISTS display_data bytea;
ALTER TABLE walls ADD COLUMN IF NOT EXISTS display_mime text;
