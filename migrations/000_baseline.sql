-- 000_baseline.sql
-- RECONSTRUCTED baseline of the current schema (as of 2026-10-25), rebuilt
-- from the application code — NOT dumped from the live database. Verify it
-- against Neon, or replace it with `pg_dump --schema-only` output (see
-- migrations/README.md), before relying on it to recreate the DB on the Pi.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text NOT NULL,
    email         text UNIQUE,
    password_hash text,
    display_name  text,
    avatar_data   bytea,
    avatar_mime   text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS walls (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name         text,
    location     text,
    image_url    text,
    image_data   bytea,
    image_mime   text,
    image_width  integer,
    image_height integer
);

CREATE TABLE IF NOT EXISTS holds (
    id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wall_id uuid NOT NULL REFERENCES walls(id) ON DELETE CASCADE,
    x_pos   double precision,
    y_pos   double precision,
    points  jsonb,
    source  text
);

CREATE TABLE IF NOT EXISTS climbs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wall_id     uuid REFERENCES walls(id) ON DELETE CASCADE,
    creator_id  uuid REFERENCES users(id),
    name        text NOT NULL,
    grade       text,
    description text,
    feet_rules  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    thumb_data  bytea,
    thumb_mime  text
);

CREATE TABLE IF NOT EXISTS climb_holds (
    climb_id uuid NOT NULL REFERENCES climbs(id) ON DELETE CASCADE,
    hold_id  uuid NOT NULL REFERENCES holds(id) ON DELETE CASCADE,
    role     text NOT NULL DEFAULT 'hand',
    PRIMARY KEY (climb_id, hold_id)
);

CREATE TABLE IF NOT EXISTS climb_sends (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    climb_id   uuid NOT NULL REFERENCES climbs(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attempts   integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now()
);
