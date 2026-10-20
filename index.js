    require('dotenv').config();
    const express = require('express');
    const cors = require('cors');
    const multer = require('multer');
    const { Pool } = require('pg');

    const app = express();
    app.use(cors());
    app.use(express.json());

    // Uploaded photos arrive in memory as req.file.buffer (never written to disk).
    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 12 * 1024 * 1024 },
    });

    // Optional SAM refinement service. Unset = skip SAM, use Roboflow polygons.
    const SAM_ENDPOINT = process.env.SAM_ENDPOINT_URL;

    // --- Auth setup ---
    const bcrypt = require('bcryptjs');
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
    const TOKEN_TTL = '30d';

    // Verifies the Bearer token and sets req.userId; 401s otherwise.
    function requireAuth(req, res, next) {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'missing token' });
        try {
            const payload = jwt.verify(token, JWT_SECRET);
            req.userId = payload.sub;
            next();
        } catch {
            return res.status(401).json({ error: 'invalid or expired token' });
        }
    }

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

    // List all walls.
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

    // GET /walls/:id — wall metadata incl. stored-image dimensions.
    app.get('/walls/:id', async (req, res) => {
        const { id } = req.params;
        try {
            const result = await pool.query(
                `SELECT id, name, location, image_width, image_height,
                        (image_data IS NOT NULL) AS has_image
                 FROM walls WHERE id = $1`,
                [id]
            );
            if (result.rows.length === 0) return res.status(404).json({ error: 'wall not found' });
            res.json({ wall: result.rows[0] });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /walls/:id/holds — the full hold catalog for a wall.
    app.get('/walls/:id/holds', async (req, res) => {
        const { id } = req.params;
        try {
            const result = await pool.query(
                'SELECT id, x_pos, y_pos, points, source FROM holds WHERE wall_id = $1',
                [id]
            );
            res.json({ holds: result.rows });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /walls/:id/image — replace the wall photo (multipart field "image" + width/height).
    app.post('/walls/:id/image', upload.single('image'), async (req, res) => {
        const { id } = req.params;
        if (!req.file) return res.status(400).json({ error: 'image file required' });

        const width = parseInt(req.body.width, 10) || null;
        const height = parseInt(req.body.height, 10) || null;

        try {
            const result = await pool.query(
                `UPDATE walls
                 SET image_data = $1, image_mime = $2, image_width = $3, image_height = $4
                 WHERE id = $5 RETURNING id`,
                [req.file.buffer, req.file.mimetype, width, height, id]
            );
            if (result.rowCount === 0) return res.status(404).json({ error: 'wall not found' });
            res.json({ ok: true, width, height });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /walls/:id/image — stream the stored photo.
    app.get('/walls/:id/image', async (req, res) => {
        const { id } = req.params;
        try {
            const result = await pool.query(
                'SELECT image_data, image_mime FROM walls WHERE id = $1',
                [id]
            );
            const row = result.rows[0];
            if (!row || !row.image_data) return res.status(404).json({ error: 'no image' });
            res.set('Content-Type', row.image_mime || 'image/jpeg');
            res.set('Cache-Control', 'no-cache');
            res.send(row.image_data);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /walls/:id/image — clear the stored photo.
    app.delete('/walls/:id/image', async (req, res) => {
        const { id } = req.params;
        try {
            const result = await pool.query(
                `UPDATE walls
                 SET image_data = NULL, image_mime = NULL, image_width = NULL, image_height = NULL
                 WHERE id = $1 RETURNING id`,
                [id]
            );
            if (result.rowCount === 0) return res.status(404).json({ error: 'wall not found' });
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;
    const ROBOFLOW_MODEL = "hold-detector-rnvkl/2";

    // Refine Roboflow polygons into fuller SAM masks via an external GPU service.
    // Returns an array aligned to predictions; each item {points:[...]} (pixel coords) or null.
    async function refineWithSam(imageBase64, predictions) {
        const resp = await fetch(SAM_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: imageBase64, points: predictions.map((p) => [p.x, p.y]) }),
        });
        if (!resp.ok) throw new Error(`SAM service ${resp.status}`);
        const data = await resp.json();
        return data.polygons;
    }

    app.post('/walls/:id/detect', async (req, res) => {
        const { id } = req.params;

        try {
            // 1. Load this wall's uploaded photo from the DB.
            const imgRes = await pool.query('SELECT image_data FROM walls WHERE id = $1', [id]);
            const imgRow = imgRes.rows[0];
            if (!imgRow || !imgRow.image_data) {
                return res.status(400).json({ error: 'No wall photo uploaded yet' });
            }
            const imageBase64 = imgRow.image_data.toString('base64');

            // 2. Call Roboflow.
            const url = `https://serverless.roboflow.com/${ROBOFLOW_MODEL}?api_key=${ROBOFLOW_API_KEY}`;
            const rfRes = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: imageBase64,
            });
            const rfData = await rfRes.json();

            const imgW = rfData.image.width;
            const imgH = rfData.image.height;

            // 3. Optional SAM refinement.
            let refined = null;
            if (SAM_ENDPOINT) {
                try {
                    refined = await refineWithSam(imageBase64, rfData.predictions);
                } catch (e) {
                    console.log('SAM refine failed, using roboflow polygons:', e.message);
                }
            }

            // 4. Replace auto holds (keep manual) and insert, all in one transaction.
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(
                    "DELETE FROM holds WHERE wall_id = $1 AND source IN ('roboflow', 'sam')",
                    [id]
                );

                for (let i = 0; i < rfData.predictions.length; i++) {
                    const pred = rfData.predictions[i];
                    const useSam = !!(refined && refined[i]);
                    const rawPoints = useSam ? refined[i].points : pred.points;
                    const source = useSam ? 'sam' : 'roboflow';

                    const normalizedPoints = rawPoints.map((p) => ({
                        x: p.x / imgW,
                        y: p.y / imgH,
                    }));

                    await client.query(
                        'INSERT INTO holds (wall_id, x_pos, y_pos, points, source) VALUES ($1, $2, $3, $4::jsonb, $5)',
                        [id, pred.x / imgW, pred.y / imgH, JSON.stringify(normalizedPoints), source]
                    );
                }

                await client.query('COMMIT');
                res.json({ inserted: rfData.predictions.length, refined: refined ? 'sam' : 'roboflow' });
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

    // DELETE /holds/:id — remove a single hold
    app.delete('/holds/:id', async (req, res) => {
        const { id } = req.params;
        try {
            const result = await pool.query(
                'DELETE FROM holds WHERE id = $1 RETURNING id',
                [id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Hold not found' });
            }
            res.json({ deleted: result.rows[0].id });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /walls/:id/holds — add a single manual hold
    app.post('/walls/:id/holds', async (req, res) => {
        const { id } = req.params;
        const { points, x_pos, y_pos } = req.body;

        if (!Array.isArray(points) || typeof x_pos !== 'number' || typeof y_pos !== 'number') {
            return res.status(400).json({ error: 'points (array), x_pos, y_pos (numbers) required' });
        }

        try {
            const result = await pool.query(
                `INSERT INTO holds (wall_id, x_pos, y_pos, points, source)
                VALUES ($1, $2, $3, $4::jsonb, $5)
                RETURNING *`,
                [id, x_pos, y_pos, JSON.stringify(points), 'manual']
            );
            res.status(201).json({ hold: result.rows[0] });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /climbs — save a new climb with its holds
    app.post('/climbs', async (req, res) => {
        const { name, grade, description, holds, wallId, creatorId } = req.body;

        if(name == "" || !Array.isArray(holds)){
            res.status(400).json({error: "basic validation issues"});
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const climbResult = await client.query(
                'INSERT INTO climbs(wall_id, creator_id, name, grade, description) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [wallId, creatorId, name, grade, description]
            );
            const climbId = climbResult.rows[0].id;

            for (const hold of holds) {
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

    // POST /auth/register — create an account, return a token.
    app.post('/auth/register', async (req, res) => {
        const { email, password, displayName } = req.body;
        if (!email || !password || password.length < 8) {
            return res.status(400).json({ error: 'email and password (min 8 chars) required' });
        }
        try {
            const hash = await bcrypt.hash(password, 10);
            const name = displayName || email; // users.name is NOT NULL
            const result = await pool.query(
                `INSERT INTO users (name, email, password_hash, display_name)
                 VALUES ($1, lower($2), $3, $4)
                 RETURNING id, email, display_name`,
                [name, email, hash, displayName || null]
            );
            const user = result.rows[0];
            const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: TOKEN_TTL });
            res.status(201).json({ token, user });
        } catch (err) {
            if (err.code === '23505') return res.status(409).json({ error: 'email already registered' });
            res.status(500).json({ error: err.message });
        }
    });

    // POST /auth/login — verify credentials, return a token.
    app.post('/auth/login', async (req, res) => {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'email and password required' });
        try {
            const result = await pool.query(
                'SELECT id, email, display_name, password_hash FROM users WHERE lower(email) = lower($1)',
                [email]
            );
            const user = result.rows[0];
            if (!user || !user.password_hash) return res.status(401).json({ error: 'invalid credentials' });
            const ok = await bcrypt.compare(password, user.password_hash);
            if (!ok) return res.status(401).json({ error: 'invalid credentials' });
            const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: TOKEN_TTL });
            res.json({ token, user: { id: user.id, email: user.email, display_name: user.display_name } });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /auth/me — current user from token.
    app.get('/auth/me', requireAuth, async (req, res) => {
        try {
            const result = await pool.query(
                'SELECT id, email, display_name FROM users WHERE id = $1',
                [req.userId]
            );
            if (result.rows.length === 0) return res.status(404).json({ error: 'user not found' });
            res.json({ user: result.rows[0] });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
