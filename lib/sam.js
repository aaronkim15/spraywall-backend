// Optional SAM refinement service. Unset = skip SAM, use Roboflow polygons.
const SAM_ENDPOINT = process.env.SAM_ENDPOINT_URL;

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

module.exports = { SAM_ENDPOINT, refineWithSam };
