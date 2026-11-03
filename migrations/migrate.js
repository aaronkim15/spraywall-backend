// Applies every migrations/*.sql in filename order, once each, recorded in a
// schema_migrations table. Safe to re-run: already-applied files are skipped.
// Fresh DB -> runs them all; existing DB -> runs only new ones.
// Usage: npm run migrate   (uses the same DATABASE_URL / DATABASE_SSL as the server)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const useSsl = process.env.DATABASE_SSL !== 'disable';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

async function main() {
  // Tracking table: which migration files have already run.
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const files = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // 000_, 001_, ... run in order

  const applied = new Set(
    (await pool.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename)
  );

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql); // one file may hold several statements
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
      ran++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`FAILED ${file}: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }
  console.log(ran === 0 ? 'no new migrations' : `done: ${ran} migration(s) applied`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
