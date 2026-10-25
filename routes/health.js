const express = require('express');
const pool = require('../db');
const router = express.Router();

// Health check: confirms the server is up AND can reach the database.
router.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', db: 'connected' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
