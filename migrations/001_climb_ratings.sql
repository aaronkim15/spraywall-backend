-- 001_climb_ratings.sql
-- Per-user star ratings (1-5). One rating per user per climb (upsert to change).
CREATE TABLE IF NOT EXISTS climb_ratings (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    climb_id   uuid NOT NULL REFERENCES climbs(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stars      integer NOT NULL CHECK (stars BETWEEN 1 AND 5),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (climb_id, user_id)
);
