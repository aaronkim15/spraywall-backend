require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Routers — each defines its full paths and is mounted at the root.
app.use(require('./routes/health'));
app.use(require('./routes/auth'));
app.use(require('./routes/walls'));
app.use(require('./routes/climbs'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
