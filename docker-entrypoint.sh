#!/bin/sh
set -e
# Postgres is already healthy (compose depends_on waits for it).
# Apply any pending migrations, then hand off to the server as PID 1.
npm run migrate
exec npm start
