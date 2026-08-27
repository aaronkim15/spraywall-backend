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

    const fs = require("fs");

    const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;
    const ROBOFLOW_MODEL = "hold-detector-rnvkl/2";

    app.post('/walls/:id/detect', async (req, res) => {
        const { id } = req.params;

        try {
            // 1. Read the wall image as base64
            const imageBase64 = fs.readFileSync("wall-image.jpg", { encoding: "base64" });

            // 2. Call Roboflow
            const url = `https://serverless.roboflow.com/${ROBOFLOW_MODEL}?api_key=${ROBOFLOW_API_KEY}`;
            const rfRes = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: imageBase64,
            });
            const rfData = await rfRes.json();
            console.log("DETECT VERSION: jsonb-fix");
            console.log(JSON.stringify(rfData, null, 2));

            // 3. Image dimensions for normalizing
            const imgW = rfData.image.width;
            const imgH = rfData.image.height;

            // 4. Normalize each prediction and insert, all in one transaction
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                for (const pred of rfData.predictions) {
                    const normalizedPoints = pred.points.map((p) => ({
                        x: p.x / imgW,
                        y: p.y / imgH,
                    }));

                    const centerX = pred.x / imgW;
                    const centerY = pred.y / imgH;
                    
                    
                    console.log("storing points as:", typeof JSON.stringify(normalizedPoints), JSON.stringify(normalizedPoints).slice(0, 40));
                    await client.query(
                        'INSERT INTO holds (wall_id, x_pos, y_pos, points, source) VALUES ($1, $2, $3, $4::jsonb, $5)',
                        [id, centerX, centerY, JSON.stringify(normalizedPoints), 'roboflow']
                    );
                }

                await client.query('COMMIT');
                res.json({ inserted: rfData.predictions.length });
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
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

    app.get('/climbs/:id', async (req, res) => {
        const { id } = req.params;
        try {

            const climbResult = await pool.query(
                'SELECT id, name, grade, description FROM climbs WHERE id = $1', [id]
            );

            if (climbResult.rows.length === 0) {
                return res.status(404).json({ error: "Climb not found" });
            }

            const holdsResult = await pool.query(
                'SELECT h.x_pos, h.y_pos, h.points FROM holds h JOIN climb_holds ch ON ch.hold_id = h.id WHERE ch.climb_id = $1',
                [id]);

            res.json({
                ...climbResult.rows[0],
                holds: holdsResult.rows,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });