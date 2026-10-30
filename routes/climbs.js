const express = require('express');
const pool = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { generateThumb } = require('../lib/images');
const { validateClimbHolds } = require('../lib/validation');
const router = express.Router();

// POST /climbs — save a new climb with its holds
router.post('/climbs', requireAuth, async (req, res) => {
    const { name, grade, angle, description, feetRules, wallId, holds } = req.body;

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
            'INSERT INTO climbs (wall_id, creator_id, name, grade, angle, description, feet_rules) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
            [wallId, req.userId, name.trim(), grade || null, angle || null, description || null, feetRules || null]
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

router.get('/climbs', optionalAuth, async (req, res) => {
    try{
        const result = await pool.query(
            `SELECT c.id, c.name, c.grade, c.angle, c.description, c.created_at,
                    COALESCE(u.display_name, u.name, u.email) AS setter_name,
                    md5(c.thumb_data) AS thumb_version,
                    (SELECT round(avg(cr.stars), 1)::float FROM climb_ratings cr WHERE cr.climb_id = c.id) AS rating,
                    (SELECT count(*)::int FROM climb_ratings cr WHERE cr.climb_id = c.id) AS rating_count,
                    (SELECT count(DISTINCT cs.user_id)::int FROM climb_sends cs WHERE cs.climb_id = c.id) AS send_count,
                    EXISTS (SELECT 1 FROM climb_sends cs WHERE cs.climb_id = c.id AND cs.user_id = $1) AS sent_by_me
             FROM climbs c
             LEFT JOIN users u ON u.id = c.creator_id
             WHERE c.archived_at IS NULL ORDER BY c.name`,
            [req.userId || null]
        );
        res.json(result.rows);
    } catch(err){
        res.status(500).json({error: err.message});
    }
});

// GET /climbs/:id/thumb — the rendered thumbnail (lazy-generated, then cached).
router.get('/climbs/:id/thumb', async (req, res) => {
    const { id } = req.params;
    try {
        const r = await pool.query('SELECT thumb_data, thumb_mime FROM climbs WHERE id = $1', [id]);
        if (r.rows.length === 0) return res.status(404).json({ error: 'climb not found' });
        let { thumb_data, thumb_mime } = r.rows[0];
        let justMade = false;
        if (!thumb_data) {
            thumb_data = await generateThumb(id);
            thumb_mime = 'image/jpeg';
            justMade = true;
            if (!thumb_data) return res.status(404).json({ error: 'no thumbnail' });
        }
        res.set('Content-Type', thumb_mime || 'image/jpeg');
        // Once cached on the row, the URL carries its hash -> cache forever.
        // The just-generated "pending" response is not cached (its URL has no hash yet).
        res.set('Cache-Control', justMade ? 'no-cache' : 'public, max-age=31536000, immutable');
        res.send(thumb_data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/climbs/:id', optionalAuth, async (req, res) => {
    const { id } = req.params;
    try {

        const climbResult = await pool.query(
            `SELECT c.id, c.name, c.grade, c.angle, c.description, c.feet_rules, c.created_at,
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
            `SELECT cs.id, cs.user_id, cs.attempts, cs.created_at,
                    COALESCE(u.display_name, u.name, u.email) AS display_name,
                    (u.avatar_data IS NOT NULL) AS has_avatar,
                    md5(u.avatar_data) AS avatar_version
             FROM climb_sends cs
             JOIN users u ON u.id = cs.user_id
             WHERE cs.climb_id = $1
             ORDER BY cs.created_at DESC`, [id]);

        // send_count = distinct climbers who have sent it (not total ascents)
        const distinctClimbers = new Set(sendsResult.rows.map((r) => r.user_id)).size;

        res.json({
            ...climbResult.rows[0],
            holds: holdsResult.rows,
            sends: sendsResult.rows,
            send_count: distinctClimbers,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /climbs/:id — soft-delete (archive) a climb. Only its creator may do this.
router.delete('/climbs/:id', requireAuth, async (req, res) => {
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
router.put('/climbs/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { name, grade, angle, description, feetRules, holds } = req.body;

    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
    }
    const vErr = validateClimbHolds(holds);
    if (vErr) return res.status(400).json({ error: vErr });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const upd = await client.query(
            'UPDATE climbs SET name = $1, grade = $2, angle = $3, description = $4, feet_rules = $5 WHERE id = $6 AND creator_id = $7 AND archived_at IS NULL RETURNING id',
            [name.trim(), grade || null, angle || null, description || null, feetRules || null, id, req.userId]
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

        await client.query('UPDATE climbs SET thumb_data = NULL, thumb_mime = NULL WHERE id = $1', [id]);
        await client.query('COMMIT');
        res.json({ id });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// POST /climbs/:id/send — log a new ascent. Attempts are captured now and
// are immutable; logging again creates another ascent (full history).
router.post('/climbs/:id/send', requireAuth, async (req, res) => {
    const { id } = req.params;
    let attempts = parseInt(req.body.attempts, 10);
    if (isNaN(attempts) || attempts < 1) attempts = 1;
    try {
        const result = await pool.query(
            `INSERT INTO climb_sends (climb_id, user_id, attempts) VALUES ($1, $2, $3)
             RETURNING id, attempts, created_at`,
            [id, req.userId, attempts]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /climbs/sends/:sendId — remove one of the current user's ascents.
router.delete('/climbs/sends/:sendId', requireAuth, async (req, res) => {
    const { sendId } = req.params;
    try {
        const result = await pool.query(
            'DELETE FROM climb_sends WHERE id = $1 AND user_id = $2 RETURNING id',
            [sendId, req.userId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'send not found or not yours' });
        res.status(204).end();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /climbs/:id/rate — set/update the current user's star rating (1-5).
router.post('/climbs/:id/rate', requireAuth, async (req, res) => {
    const { id } = req.params;
    const stars = parseInt(req.body.stars, 10);
    if (isNaN(stars) || stars < 1 || stars > 5) {
        return res.status(400).json({ error: 'stars must be an integer 1-5' });
    }
    try {
        await pool.query(
            `INSERT INTO climb_ratings (climb_id, user_id, stars) VALUES ($1, $2, $3)
             ON CONFLICT (climb_id, user_id) DO UPDATE SET stars = EXCLUDED.stars`,
            [id, req.userId, stars]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /climbs/:id/rate — remove the current user's rating.
router.delete('/climbs/:id/rate', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM climb_ratings WHERE climb_id = $1 AND user_id = $2', [id, req.userId]);
        res.status(204).end();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
