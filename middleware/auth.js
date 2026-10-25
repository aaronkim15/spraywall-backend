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

// Like requireAuth but never rejects: sets req.userId if a valid token is present.
function optionalAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) {
        try { req.userId = jwt.verify(token, JWT_SECRET).sub; } catch { /* ignore */ }
    }
    next();
}

module.exports = { requireAuth, optionalAuth, JWT_SECRET, TOKEN_TTL };
