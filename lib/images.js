const multer = require('multer');
const sharp = require('sharp');
const pool = require('../db');

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

// Role -> outline colour for rendered thumbnails (matches the frontend).
const ROLE_HEX = { start: '#ef4444', finish: '#ef4444', hand: '#ffffff', foot: '#22c55e' };

// Render a climb's thumbnail (wall photo + hold outlines) once and cache it on the row.
async function generateThumb(climbId) {
    const climbRes = await pool.query('SELECT wall_id FROM climbs WHERE id = $1', [climbId]);
    if (climbRes.rows.length === 0) return null;
    const wallRes = await pool.query('SELECT image_data FROM walls WHERE id = $1', [climbRes.rows[0].wall_id]);
    const imgData = wallRes.rows[0] && wallRes.rows[0].image_data;
    if (!imgData) return null;

    const holdsRes = await pool.query(
        'SELECT h.points, ch.role FROM climb_holds ch JOIN holds h ON h.id = ch.hold_id WHERE ch.climb_id = $1',
        [climbId]
    );
    // Resize the photo first, then overlay the SVG sized to the RESIZED image,
    // so the composite is guaranteed to fit exactly. .rotate() bakes EXIF
    // orientation so the outlines line up with what the phone displayed.
    const base = await sharp(imgData).rotate().resize({ width: 400, withoutEnlargement: true }).toBuffer();
    const m = await sharp(base).metadata();
    const W = m.width, H = m.height;
    const stroke = Math.max(2, Math.round(Math.min(W, H) * 0.012));
    const polys = holdsRes.rows.map((r) => {
        if (!r.points) return '';
        const pts = r.points.map((pt) => `${(pt.x * W).toFixed(1)},${(pt.y * H).toFixed(1)}`).join(' ');
        const color = ROLE_HEX[r.role] || '#9aa0a6';
        return `<polygon points="${pts}" fill="none" stroke="${color}" stroke-width="${stroke}"/>`;
    }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${polys}</svg>`;

    const buf = await sharp(base)
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .jpeg({ quality: 72 })
        .toBuffer();

    await pool.query('UPDATE climbs SET thumb_data = $1, thumb_mime = $2 WHERE id = $3', [buf, 'image/jpeg', climbId]);
    return buf;
}

// Downscale a wall photo to a display size (~1600px wide) and cache it on the row.
async function generateWallDisplay(wallId) {
    const r = await pool.query('SELECT image_data FROM walls WHERE id = $1', [wallId]);
    const imgData = r.rows[0] && r.rows[0].image_data;
    if (!imgData) return null;
    const buf = await sharp(imgData)
        .rotate() // bake EXIF orientation
        .resize({ width: 1600, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
    await pool.query('UPDATE walls SET display_data = $1, display_mime = $2 WHERE id = $3', [buf, 'image/jpeg', wallId]);
    return buf;
}

module.exports = { upload, isImageBuffer, generateThumb, generateWallDisplay, ROLE_HEX };
