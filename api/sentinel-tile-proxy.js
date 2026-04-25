/**
 * sentinel-tile-proxy.js  — v4 PRODUCTION
 * ════════════════════════════════════════════════════════════════════════════
 * XYZ → WMS tile proxy for Copernicus Data Space (CDSE) Sentinel Hub.
 *
 * ROUTE:  GET /api/sentinel-tile-proxy/[z]/[x]/[y]
 *   OR:   GET /api/sentinel-tile-proxy?z=&x=&y=&layer=&year=
 *
 * WHY XYZ (not {bbox-epsg-3857}):
 *   MapLibre sends {bbox-epsg-3857} as a comma-separated Web Mercator bbox.
 *   CDSE WMS 1.3.0 with CRS=EPSG:4326 requires lat/lon in axis-correct order
 *   (miny,minx,maxy,maxx). Converting Mercator→Geographic server-side is the
 *   only reliable approach — the old bbox proxy returned XML errors because
 *   MapLibre replaced {bbox-epsg-3857} with Mercator metres, not degrees.
 *   Switching to XYZ tile coordinates (z/x/y) lets us do the math here and
 *   construct a geometrically perfect WMS bbox every time.
 *
 * HOW IT WORKS:
 *   1. Vercel routes /api/sentinel-tile-proxy/[z]/[x]/[y] here via rewrites.
 *   2. We convert tile (z,x,y) → EPSG:4326 bounding box (miny,minx,maxy,maxx).
 *   3. Fetch a cached CDSE OAuth2 token using server-side client credentials.
 *   4. Build the CDSE WMS GetMap URL with the correct instance path and params.
 *   5. Stream the JPEG tile back with cache headers.
 *
 * LAYER NAMES (verified against CDSE GetCapabilities, April 2026):
 *   Sentinel-2  (2015–present):  TRUE-COLOR
 *   Landsat-8/9 (2013–2014):     LANDSAT-OLI-L2-TRUE-COLOR
 *   Landsat TM  (pre-2013):      LANDSAT-TM-L1-TRUE-COLOR
 *
 * ENV VARS (set in Vercel project → Settings → Environment Variables):
 *   SENTINEL_CLIENT_ID      — full "sh-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 *   SENTINEL_CLIENT_SECRET  — client secret from Copernicus Data Space
 * ════════════════════════════════════════════════════════════════════════════
 */

// ── Module-level token cache (survives warm Lambda invocations) ───────────
let _cachedToken  = null;
let _tokenExpiry  = 0;

// ── Tile math ─────────────────────────────────────────────────────────────

/**
 * Convert XYZ tile coordinates to EPSG:4326 geographic bbox.
 * Returns { minLon, minLat, maxLon, maxLat } in decimal degrees.
 */
function tile2bbox(z, x, y) {
  const n  = Math.pow(2, z);
  const minLon =  (x / n) * 360 - 180;
  const maxLon = ((x + 1) / n) * 360 - 180;
  // Latitude from Mercator — note Y axis is inverted in tile coords
  const maxLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)))       * 180 / Math.PI;
  const minLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return { minLon, minLat, maxLon, maxLat };
}

// ── OAuth token ───────────────────────────────────────────────────────────

async function getCDSEToken(clientId, clientSecret) {
  const now = Date.now();
  if (_cachedToken && _tokenExpiry > now + 30_000) return _cachedToken;

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(
    'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    }
  );

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`CDSE token error ${res.status}: ${txt.slice(0, 300)}`);
  }

  const data     = await res.json();
  _cachedToken   = data.access_token;
  _tokenExpiry   = now + ((data.expires_in || 600) - 60) * 1000;
  return _cachedToken;
}

// ── Layer selection ───────────────────────────────────────────────────────

function layerForYear(year, requestedLayer) {
  if (requestedLayer) {
    // Auto-correct deprecated names
    const deprecated = {
      'LANDSAT-8-TRUE-COLOR':   'LANDSAT-OLI-L2-TRUE-COLOR',
      'LANDSAT-9-TRUE-COLOR':   'LANDSAT-OLI-L2-TRUE-COLOR',
      'LANDSAT-TM-TRUE-COLOR':  'LANDSAT-TM-L1-TRUE-COLOR',
      'LANDSAT45-TRUE-COLOR':   'LANDSAT-TM-L1-TRUE-COLOR',
    };
    return deprecated[requestedLayer] ?? requestedLayer;
  }
  const y = parseInt(year, 10);
  if (y >= 2015) return 'TRUE-COLOR';
  if (y >= 2013) return 'LANDSAT-OLI-L2-TRUE-COLOR';
  return 'LANDSAT-TM-L1-TRUE-COLOR';
}

// ── Main handler ──────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  // Credentials
  const clientId     = process.env.SENTINEL_CLIENT_ID;
  const clientSecret = process.env.SENTINEL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'Sentinel credentials not configured' });
  }

  // ── Parse tile coordinates ─────────────────────────────────────────────
  // Support both:
  //   /api/sentinel-tile-proxy/[z]/[x]/[y]  (Vercel dynamic route via rewrites)
  //   /api/sentinel-tile-proxy?z=&x=&y=     (query-param fallback)
  let z, x, y;

  // Vercel dynamic segments arrive in req.query when using rewrites like:
  //   { "source": "/api/sentinel-tile-proxy/:z/:x/:y", "destination": "/api/sentinel-tile-proxy?z=:z&x=:x&y=:y" }
  // They also arrive as path fragments — try query first, then parse req.url
  if (req.query.z !== undefined && req.query.x !== undefined && req.query.y !== undefined) {
    z = parseInt(req.query.z, 10);
    x = parseInt(req.query.x, 10);
    y = parseInt(req.query.y, 10);
  } else {
    // Parse from URL path: /api/sentinel-tile-proxy/14/9010/8006
    const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
    // parts = ['api', 'sentinel-tile-proxy', '14', '9010', '8006']
    const idx = parts.indexOf('sentinel-tile-proxy');
    if (idx !== -1 && parts.length >= idx + 4) {
      z = parseInt(parts[idx + 1], 10);
      x = parseInt(parts[idx + 2], 10);
      y = parseInt(parts[idx + 3], 10);
    }
  }

  // Validate
  if (isNaN(z) || isNaN(x) || isNaN(y) || z < 0 || z > 22) {
    return res.status(400).json({
      error: 'Missing or invalid tile coordinates. Provide z, x, y as path segments or query params.',
      received: { z: req.query.z, x: req.query.x, y: req.query.y, url: req.url }
    });
  }

  // Other params
  const yr    = parseInt(req.query.year || req.query.y_year || new Date().getFullYear(), 10);
  const layer = layerForYear(yr, req.query.layer || '');
  const w     = Math.min(1024, Math.max(64, parseInt(req.query.width  || '512', 10)));
  const h     = Math.min(1024, Math.max(64, parseInt(req.query.height || '512', 10)));

  // ── Convert tile → geographic bbox ────────────────────────────────────
  const { minLon, minLat, maxLon, maxLat } = tile2bbox(z, x, y);

  // WMS 1.3.0 with CRS=EPSG:4326: axis order is LAT,LON (miny,minx,maxy,maxx)
  const wms130bbox = `${minLat},${minLon},${maxLat},${maxLon}`;

  // TIME: use full year range for best cloud-free composite
  const timeFrom = `${yr}-01-01`;
  const timeTo   = `${yr}-12-31`;

  try {
    const token = await getCDSEToken(clientId, clientSecret);

    // CDSE WMS endpoint — instance ID MUST be in path
    const wmsUrl = new URL(
      `https://sh.dataspace.copernicus.eu/ogc/wms/${encodeURIComponent(clientId)}`
    );
    wmsUrl.searchParams.set('REQUEST', 'GetMap');
    wmsUrl.searchParams.set('VERSION', '1.3.0');
    wmsUrl.searchParams.set('SERVICE', 'WMS');
    wmsUrl.searchParams.set('LAYERS',  layer);
    wmsUrl.searchParams.set('FORMAT',  'image/jpeg');
    wmsUrl.searchParams.set('CRS',     'EPSG:4326');
    wmsUrl.searchParams.set('WIDTH',   String(w));
    wmsUrl.searchParams.set('HEIGHT',  String(h));
    wmsUrl.searchParams.set('TIME',    `${timeFrom}/${timeTo}`);
    wmsUrl.searchParams.set('MAXCC',   '30');   // max 30% cloud cover
    wmsUrl.searchParams.set('BBOX',    wms130bbox);

    const tileRes = await fetch(wmsUrl.toString(), {
      method:  'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'image/jpeg,image/*,*/*',
      },
    });

    if (!tileRes.ok) {
      const errText = await tileRes.text();
      console.error(`[sentinel-tile-proxy] CDSE ${tileRes.status} z=${z} x=${x} y=${y} layer=${layer}:`, errText.slice(0, 400));
      return res.status(tileRes.status).json({
        error: 'CDSE WMS error', status: tileRes.status,
        layer, year: yr, z, x, y,
        detail: errText.slice(0, 200),
      });
    }

    const contentType = tileRes.headers.get('content-type') || 'image/jpeg';

    // Reject XML/JSON error responses masquerading as 200 OK
    if (!contentType.includes('image/')) {
      const errText = await tileRes.text();
      console.error(`[sentinel-tile-proxy] CDSE returned non-image content-type: ${contentType}`, errText.slice(0, 300));
      return res.status(502).json({
        error: 'CDSE returned non-image response', contentType,
        layer, year: yr, z, x, y,
        detail: errText.slice(0, 200),
      });
    }

    const tileBuffer = await tileRes.arrayBuffer();
    res.setHeader('Content-Type',       contentType);
    res.setHeader('Cache-Control',      'public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('X-Sentinel-Layer',   layer);
    res.setHeader('X-Sentinel-Year',    String(yr));
    res.setHeader('X-Tile-Coords',      `${z}/${x}/${y}`);
    res.setHeader('X-Tile-Bbox-4326',   wms130bbox);
    return res.status(200).send(Buffer.from(tileBuffer));

  } catch (err) {
    console.error('[sentinel-tile-proxy] error:', err.message);
    return res.status(500).json({ error: 'Tile proxy error', detail: err.message });
  }
}