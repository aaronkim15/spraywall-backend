const { Pool } = require('pg');

// Neon requires SSL. rejectUnauthorized:false avoids local cert-chain issues.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

module.exports = pool;
