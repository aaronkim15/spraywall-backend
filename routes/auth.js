const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { requireAuth, JWT_SECRET, TOKEN_TTL } = require('../middleware/auth');
const { upload, isImageBuffer } = require('../lib/images');
const router = express.Router();

// POST /auth/register — create an account, return a token.
router.post('/auth/register', async (req, res) => {
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
router.post('/auth/login', async (req, res) => {
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
router.get('/auth/me', requireAuth, async (req, res) => {
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
router.patch('/auth/email', requireAuth, async (req, res) => {
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
router.patch('/auth/password', requireAuth, async (req, res) => {
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
router.post('/auth/avatar', requireAuth, upload.single('image'), async (req, res) => {
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
router.get('/users/:id/avatar', async (req, res) => {
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

module.exports = router;
