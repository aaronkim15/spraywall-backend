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
        fileFilter: (req, file, cb) => {
            // quick mimetype gate; the route also checks the real bytes
            cb(null, file.mimetype.startsWith('image/'));
        },
    });

    // Verify the actual bytes look like a known image format (not a spoofed file).
    function isImageBuffer(buf) {
        if (!buf || buf.length < 12) return false;
        if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
        if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
        if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return true; // WEBP
        if (buf.slice(4, 8).toString('ascii') === 'ftyp') { // HEIC/HEIF (iPhone)
            const brand = buf.slice(8, 12).toString('ascii');
            if (['heic', 'heix', 'mif1', 'msf1', 'hevc', 'hevx'].includes(brand)) return true;
        }
        return false;
    }

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
                        (image_data IS NOT NULL) AS has_image,
                        md5(image_data) AS image_version
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
        if (!isImageBuffer(req.file.buffer)) {
            return res.status(400).json({ error: 'file is not a valid image' });
        }

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
            // A new photo changes the coordinate basis, so old holds no longer apply.
            await pool.query('DELETE FROM holds WHERE wall_id = $1', [id]);
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
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
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
            await pool.query('DELETE FROM holds WHERE wall_id = $1', [id]);
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

    // POST /walls/:id/refine — optionally clean up hand-drawn outlines with SAM.
    // Returns the outlines unchanged when SAM is not configured.
    app.post('/walls/:id/refine', async (req, res) => {
        const { id } = req.params;
        const { outlines } = req.body;
        if (!Array.isArray(outlines) || outlines.length === 0) {
            return res.status(400).json({ error: 'outlines required' });
        }
        try {
            if (!SAM_ENDPOINT) {
                return res.json({ outlines, refined: false });
            }
            const imgRes = await pool.query(
                'SELECT image_data, image_width, image_height FROM walls WHERE id = $1',
                [id]
            );
            const row = imgRes.rows[0];
            if (!row || !row.image_data || !row.image_width || !row.image_height) {
                return res.status(400).json({ error: 'no wall photo' });
            }
            const imageBase64 = row.image_data.toString('base64');
            const imgW = row.image_width;
            const imgH = row.image_height;

            // Each outline's centroid becomes a SAM point prompt (in pixels).
            const predictions = outlines.map((o) => {
                const cx = o.reduce((s, p) => s + p.x, 0) / o.length;
                const cy = o.reduce((s, p) => s + p.y, 0) / o.length;
                return { x: cx * imgW, y: cy * imgH };
            });

            let refined = null;
            try {
                refined = await refineWithSam(imageBase64, predictions);
            } catch (e) {
                console.log('refine SAM failed:', e.message);
            }

            const out = outlines.map((o, i) => {
                if (refined && refined[i]) {
                    return refined[i].points.map((p) => ({ x: p.x / imgW, y: p.y / imgH }));
                }
                return o; // SAM found nothing here: keep the hand-drawn outline
            });
            res.json({ outlines: out, refined: !!refined });
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

    // Shared climb-hold validation — the authoritative copy of the UI rules.
    function validateClimbHolds(holds) {
        if (!Array.isArray(holds) || holds.length === 0) return 'at least one hold is required';
        const counts = {};
        for (const h of holds) counts[h.role] = (counts[h.role] || 0) + 1;
        if (!counts.start) return 'a start hold is required';
        if (!counts.finish) return 'a finish hold is required';
        if (!counts.hand) return 'a hybrid hold is required';
        if (counts.start > 2) return 'max 2 start holds';
        if (counts.finish > 2) return 'max 2 finish holds';
        return null;
    }

    // POST /climbs — save a new climb with its holds
    app.post('/climbs', requireAuth, async (req, res) => {
        const { name, grade, description, feetRules, wallId, holds } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'name is required' });
        }
        const vErr = validateClimbHolds(holds);
        if (vErr) return res.status(400).json({ error: vErr });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // creator comes from the auth token, never from the client body
            const climbResult = await client.query(
                'INSERT INTO climbs (wall_id, creator_id, name, grade, description, feet_rules) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
                [wallId, req.userId, name.trim(), grade || null, description || null, feetRules || null]
            );
            const climbId = climbResult.rows[0].id;

            // Link EXISTING holds to this climb, each with its role. No new holds created.
            for (const h of holds) {
                await client.query(
                    'INSERT INTO climb_holds (climb_id, hold_id, role) VALUES ($1, $2, $3)',
                    [climbId, h.id, h.role || 'hand']
                );
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
                `SELECT c.id, c.name, c.grade, c.description,
                        (SELECT count(*)::int FROM climb_sends cs WHERE cs.climb_id = c.id) AS send_count
                 FROM climbs c WHERE c.archived_at IS NULL ORDER BY c.name`
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
                `SELECT c.id, c.name, c.grade, c.description, c.feet_rules, c.created_at,
                        c.creator_id,
                        COALESCE(u.display_name, u.name, u.email) AS setter_name
                 FROM climbs c
                 LEFT JOIN users u ON u.id = c.creator_id
                 WHERE c.id = $1`, [id]
            );

            if (climbResult.rows.length === 0) {
                return res.status(404).json({ error: "Climb not found" });
            }

            const holdsResult = await pool.query(
                'SELECT h.id, h.x_pos, h.y_pos, h.points, ch.role FROM holds h JOIN climb_holds ch ON ch.hold_id = h.id WHERE ch.climb_id = $1',
                [id]);

            // Who has sent this climb (most recent first).
            const sendsResult = await pool.query(
                `SELECT cs.user_id, cs.created_at,
                        COALESCE(u.display_name, u.name, u.email) AS display_name,
                        (u.avatar_data IS NOT NULL) AS has_avatar,
                        md5(u.avatar_data) AS avatar_version
                 FROM climb_sends cs
                 JOIN users u ON u.id = cs.user_id
                 WHERE cs.climb_id = $1
                 ORDER BY cs.created_at DESC`, [id]);

            res.json({
                ...climbResult.rows[0],
                holds: holdsResult.rows,
                sends: sendsResult.rows,
                send_count: sendsResult.rows.length,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /climbs/:id — soft-delete (archive) a climb. Only its creator may do this.
    app.delete('/climbs/:id', requireAuth, async (req, res) => {
        const { id } = req.params;
        try {
            const result = await pool.query(
                'UPDATE climbs SET archived_at = now() WHERE id = $1 AND creator_id = $2 AND archived_at IS NULL RETURNING id',
                [id, req.userId]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Climb not found or not yours' });
            }
            res.status(204).end();
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // PUT /climbs/:id — update a climb and replace its holds. Creator only.
    app.put('/climbs/:id', requireAuth, async (req, res) => {
        const { id } = req.params;
        const { name, grade, description, feetRules, holds } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'name is required' });
        }
        const vErr = validateClimbHolds(holds);
        if (vErr) return res.status(400).json({ error: vErr });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const upd = await client.query(
                'UPDATE climbs SET name = $1, grade = $2, description = $3, feet_rules = $4 WHERE id = $5 AND creator_id = $6 AND archived_at IS NULL RETURNING id',
                [name.trim(), grade || null, description || null, feetRules || null, id, req.userId]
            );
            if (upd.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Climb not found or not yours' });
            }

            // Replace the hold set wholesale: clear the old links, insert the new ones.
            await client.query('DELETE FROM climb_holds WHERE climb_id = $1', [id]);
            for (const h of holds) {
                await client.query(
                    'INSERT INTO climb_holds (climb_id, hold_id, role) VALUES ($1, $2, $3)',
                    [id, h.id, h.role || 'hand']
                );
            }

            await client.query('COMMIT');
            res.json({ id });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    // POST /climbs/:id/send — log that the current user sent this climb.
    app.post('/climbs/:id/send', requireAuth, async (req, res) => {
        const { id } = req.params;
        try {
            await pool.query(
                `INSERT INTO climb_sends (climb_id, user_id) VALUES ($1, $2)
                 ON CONFLICT (climb_id, user_id) DO NOTHING`,
                [id, req.userId]
            );
            res.status(201).json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /climbs/:id/send — remove the current user's send.
    app.delete('/climbs/:id/send', requireAuth, async (req, res) => {
        const { id } = req.params;
        try {
            await pool.query('DELETE FROM climb_sends WHERE climb_id = $1 AND user_id = $2', [id, req.userId]);
            res.status(204).end();
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
                `SELECT id, email, display_name,
                        (avatar_data IS NOT NULL) AS has_avatar,
                        md5(avatar_data) AS avatar_version
                 FROM users WHERE id = $1`,
                [req.userId]
            );
            if (result.rows.length === 0) return res.status(404).json({ error: 'user not found' });
            res.json({ user: result.rows[0] });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // PATCH /auth/email — change the signed-in user's email.
    app.patch('/auth/email', requireAuth, async (req, res) => {
        const { email } = req.body;
        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'a valid email is required' });
        }
        try {
            const result = await pool.query(
                `UPDATE users SET email = lower($1) WHERE id = $2
                 RETURNING id, email, display_name,
                           (avatar_data IS NOT NULL) AS has_avatar,
                           md5(avatar_data) AS avatar_version`,
                [email, req.userId]
            );
            res.json({ user: result.rows[0] });
        } catch (err) {
            if (err.code === '23505') return res.status(409).json({ error: 'email already in use' });
            res.status(500).json({ error: err.message });
        }
    });

    // PATCH /auth/password — change password after verifying the current one.
    app.patch('/auth/password', requireAuth, async (req, res) => {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword || newPassword.length < 8) {
            return res.status(400).json({ error: 'current password and a new password (min 8 chars) are required' });
        }
        try {
            const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
            if (result.rows.length === 0) return res.status(404).json({ error: 'user not found' });

            const ok = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
            if (!ok) return res.status(400).json({ error: 'current password is incorrect' });

            const hash = await bcrypt.hash(newPassword, 10);
            await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.userId]);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /auth/avatar — upload/replace the signed-in user's profile photo.
    app.post('/auth/avatar', requireAuth, upload.single('image'), async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'image file required' });
        if (!isImageBuffer(req.file.buffer)) {
            return res.status(400).json({ error: 'file is not a valid image' });
        }
        try {
            const result = await pool.query(
                `UPDATE users SET avatar_data = $1, avatar_mime = $2 WHERE id = $3
                 RETURNING md5(avatar_data) AS avatar_version`,
                [req.file.buffer, req.file.mimetype, req.userId]
            );
            res.json({ ok: true, avatar_version: result.rows[0].avatar_version });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /users/:id/avatar — stream a user's profile photo (public; cached by content hash).
    app.get('/users/:id/avatar', async (req, res) => {
        const { id } = req.params;
        try {
            const result = await pool.query('SELECT avatar_data, avatar_mime FROM users WHERE id = $1', [id]);
            const row = result.rows[0];
            if (!row || !row.avatar_data) return res.status(404).json({ error: 'no avatar' });
            res.set('Content-Type', row.avatar_mime || 'image/jpeg');
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
            res.send(row.avatar_data);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
