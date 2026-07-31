require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// Neon requires SSL. rejectUnauthorized:false avoids local cert-chain issues.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

// Health check: confirms the server is up AND can reach the database.
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', db: 'connected' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Real endpoint proving your migrated tables are queryable.
app.get('/walls', async (req, res) => {
    try {
        const result = await pool.query(
        'SELECT id, name, location, image_url FROM walls ORDER BY name'
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /climbs — save a new climb with its holds
app.post('/climbs', async (req, res) => {
    const { name, grade, description, holds, wallId, creatorId } = req.body;

    // TODO: basic validation — reject if name is missing or holds isn't an array.
    //       Return res.status(400).json({ error: "..." }) if invalid.
    if(name == "" || !Array.isArray(holds)){
        res.status(400).json({error: "basic validation issues"});
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // TODO 1: Insert the climb into the `climbs` table.
        //   Columns: wall_id, creator_id, name, grade, archived_at(leave null)
        //   Use RETURNING id so you get the new climb's id.
        //   Store it in a variable, e.g. const climbId = result.rows[0].id;

        const climbResult = await client.query(
            /* your INSERT ... RETURNING id here, with $1,$2,... params */
            'INSERT INTO climbs(wall_id, creator_id, name, grade, description) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [wallId, creatorId, name, grade, description]
        );
        const climbId = climbResult.rows[0].id;

        // TODO 2: Loop over `holds`. For each hold:
        //   a) INSERT into `holds` (wall_id, x_pos, y_pos) RETURNING id
        //   b) INSERT into `climb_holds` (climb_id, hold_id)
        //   Hint: a `for (const hold of holds) { ... }` loop with awaits inside.
        for (const hold of holds) {
            // a) insert the hold, get its id
            // b) link it to the climb

            const holdsResult = await client.query(
                'INSERT INTO holds(wall_id, x_pos, y_pos) VALUES($1, $2, $3) RETURNING id',
                [wallId, hold.x, hold.y]
            );
            const holdId = holdsResult.rows[0].id;

            await client.query(
                'INSERT INTO climb_holds(climb_id, hold_id) VALUES($1, $2)',
                [climbId, holdId]
            )
        }

        await client.query('COMMIT');
        res.status(201).json({ id: climbId });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.get('/climbs', async(req, res) => {
    try{
        const result = await pool.query(
            'SELECT id, name, grade, description FROM climbs WHERE archived_at IS NULL ORDER by name'
        );
        res.json(result.rows);
    } catch(err){
        res.status(500).json({error: err.message});
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});