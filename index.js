require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Log every request: method, path, status, time. Shows in `docker compose logs -f api`.
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
});

// Routers — each defines its full paths and is mounted at the root.
app.use(require('./routes/health'));
app.use(require('./routes/auth'));
app.use(require('./routes/walls'));
app.use(require('./routes/climbs'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
