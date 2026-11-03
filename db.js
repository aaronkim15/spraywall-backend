const { Pool } = require('pg');

// SSL is required by managed Postgres like Neon, but a local/self-hosted
// Postgres (e.g. the Pi's Docker Postgres) serves plain TCP with no TLS.
// Default: SSL on (keeps Neon/Render working). Set DATABASE_SSL=disable for the Pi.
const useSsl = process.env.DATABASE_SSL !== 'disable';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
});

module.exports = pool;
