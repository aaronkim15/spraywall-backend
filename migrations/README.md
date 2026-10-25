# Database migrations

Numbered, ordered SQL files that define and evolve the schema. The point: the
database can be recreated from scratch (e.g. on the Raspberry Pi) by running
these in order, and every schema change is reviewable in git instead of being
pasted into the Neon console and forgotten.

## Convention

- Files are `NNN_description.sql`, applied in ascending order.
- `000_baseline.sql` is the full current schema — the starting point.
- Each later file is ONE change (e.g. `001_add_ratings.sql`). Use
  `IF NOT EXISTS` / `IF EXISTS` so a re-run is harmless.
- NEVER edit a migration that has already been applied anywhere. To change
  something, add a new, higher-numbered migration.

## Applying them

Against any Postgres (Neon now, the Pi's local Postgres later):

    psql "$DATABASE_URL" -f migrations/000_baseline.sql
    # then each later NNN_*.sql in order

## IMPORTANT: make the baseline authoritative

`000_baseline.sql` was RECONSTRUCTED from the application code, not dumped from
the live database, so the exact column types/constraints on the original tables
(users, walls, holds, climbs, climb_holds) are best-guess. Before relying on it
to rebuild the DB on the Pi, replace it with a real dump from Neon:

    pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" > migrations/000_baseline.sql

Run that on your Mac, where the Neon connection string works (it's in the
backend `.env` as DATABASE_URL).

## Changes made this session (folded into the baseline, listed for history)

Applied by hand to Neon while building; already reflected in the baseline:
- climbs: add `feet_rules`, `created_at`, `thumb_data`, `thumb_mime`
- climb_holds: add `role` (NOT NULL default 'hand')
- users: add `avatar_data`, `avatar_mime`
- climb_sends: created — ascent history, `attempts`, no unique constraint
