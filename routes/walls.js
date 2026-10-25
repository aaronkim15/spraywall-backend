const express = require('express');
const pool = require('../db');
const { upload, isImageBuffer } = require('../lib/images');
const { SAM_ENDPOINT, refineWithSam } = require('../lib/sam');
const router = express.Router();

const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;
const ROBOFLOW_MODEL = "hold-detector-rnvkl/2";

// List all walls.
router.get('/walls', async (req, res) => {
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
router.get('/walls/:id', async (req, res) => {
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
router.get('/walls/:id/holds', async (req, res) => {
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
router.post('/walls/:id/image', upload.single('image'), async (req, res) => {
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
        await pool.query('UPDATE climbs SET thumb_data = NULL, thumb_mime = NULL WHERE wall_id = $1', [id]);
        res.json({ ok: true, width, height });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /walls/:id/image — stream the stored photo.
router.get('/walls/:id/image', async (req, res) => {
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
router.delete('/walls/:id/image', async (req, res) => {
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

router.post('/walls/:id/detect', async (req, res) => {
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
router.post('/walls/:id/refine', async (req, res) => {
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
router.delete('/holds/:id', async (req, res) => {
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
router.post('/walls/:id/holds', async (req, res) => {
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

module.exports = router;
