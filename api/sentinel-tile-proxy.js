/**
 * sentinel-tile-proxy.js
 * ════════════════════════════════════════════════════════════════════════════
 * Production-grade Sentinel Hub / Copernicus CDSE tile proxy.
 *
 * WHY THIS IS NEEDED:
 *   1. Browser cannot set Authorization: Bearer headers on MapLibre raster
 *      tile requests — only query params are possible.
 *   2. CDSE WMS with access_token as a query param still returns 404 on
 *      generic endpoints — the correct URL requires the OAuth client_id
 *      (without "sh-" prefix) embedded as the WMS instance path.
 *   3. CORS: sh.dataspace.copernicus.eu rejects cross-origin tile fetches
 *      from Vercel domain without a proxy.
 *
 * HOW IT WORKS:
 *   - Receives tile params (layer, year, bbox, width, height) from the client
 *   - Fetches a fresh OAuth2 token using server-side client credentials
 *   - Constructs the correct CDSE WMS URL with instance path
 *   - Proxies the JPEG tile back to the browser with correct CORS headers
 *   - Caches tokens in module scope to avoid re-fetching on every tile
 *
 * ENDPOINT: GET /api/sentinel-tile-proxy
 * PARAMS:
 *   layer  - WMS layer name (TRUE-COLOR, LANDSAT-OLI-L2-TRUE-COLOR, etc.)
 *   year   - imagery year (used for TIME param)
 *   bbox   - EPSG:3857 bbox string "minx,miny,maxx,maxy"
 *   width  - tile width in px (default 512)
 *   height - tile height in px (default 512)
 * ════════════════════════════════════════════════════════════════════════════
 */

// Module-level token cache (survives warm Vercel Lambda invocations)
let _cachedToken = null;
let _tokenExpiry = 0;

/**
 * Fetches a CDSE OAuth2 token, returning a cached one if still valid.
 */
async function getCDSEToken(clientId, clientSecret) {
  const now = Date.now();
  if (_cachedToken && _tokenExpiry > now + 30000) {
    return _cachedToken;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(
    'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }
  );

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`CDSE token error ${res.status}: ${txt}`);
  }

  const data = await res.json();
  _cachedToken = data.access_token;
  // expires_in is in seconds; subtract 60s safety buffer
  _tokenExpiry = now + ((data.expires_in || 600) - 60) * 1000;
  return _cachedToken;
}

/**
 * Maps a year to the correct CDSE Sentinel Hub WMS layer name.
 * These are the verified Copernicus Data Space layer identifiers.
 *
 * Sentinel-2 (2015–present):   TRUE-COLOR
 * Landsat-8/9 (2013–2014):     LANDSAT-OLI-L2-TRUE-COLOR
 * Landsat 4-5 TM (pre-2013):   LANDSAT-TM-L1-TRUE-COLOR
 *
 * NOTE: The old names LANDSAT-8-TRUE-COLOR / LANDSAT-TM-TRUE-COLOR are
 * DEPRECATED on CDSE and return 404. Use the new names above.
 */
function layerForYear(year, requestedLayer) {
  // If the client explicitly requests a layer, use it (but still
  // auto-correct deprecated names)
  if (requestedLayer) {
    // Auto-correct deprecated layer names
    const deprecated = {
      'LANDSAT-8-TRUE-COLOR':  'LANDSAT-OLI-L2-TRUE-COLOR',
      'LANDSAT-9-TRUE-COLOR':  'LANDSAT-OLI-L2-TRUE-COLOR',
      'LANDSAT-TM-TRUE-COLOR': 'LANDSAT-TM-L1-TRUE-COLOR',
      'LANDSAT45-TRUE-COLOR':  'LANDSAT-TM-L1-TRUE-COLOR',
    };
    return deprecated[requestedLayer] || requestedLayer;
  }

  const y = parseInt(year, 10);
  if (y >= 2015) return 'TRUE-COLOR';
  if (y >= 2013) return 'LANDSAT-OLI-L2-TRUE-COLOR';
  return 'LANDSAT-TM-L1-TRUE-COLOR';
}

/**
 * Extracts the WMS instance ID from the SENTINEL_CLIENT_ID env var.
 * CDSE OAuth client IDs have the form "sh-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 * The WMS instance path uses the full client_id.
 */
function getInstanceId(clientId) {
  return clientId; // CDSE uses the full client_id as the instance identifier
}

export default async function handler(req, res) {
  // ── CORS headers ──────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Credentials check ─────────────────────────────────────────────────────
  const clientId     = process.env.SENTINEL_CLIENT_ID;
  const clientSecret = process.env.SENTINEL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'Sentinel credentials not configured' });
  }

  // ── Parse request params ──────────────────────────────────────────────────
  const { bbox, year, layer: reqLayer, width = '512', height = '512' } = req.query;

  if (!bbox) {
    return res.status(400).json({ error: 'Missing required param: bbox' });
  }

  const yr    = parseInt(year, 10) || new Date().getFullYear();
  const layer = layerForYear(yr, reqLayer);
  const w     = Math.min(1024, Math.max(64, parseInt(width,  10) || 512));
  const h     = Math.min(1024, Math.max(64, parseInt(height, 10) || 512));

  // TIME param: use the best seasonal window for cloud-free imagery
  // Dry season for Accra (Ghana): Nov–Mar. Use full-year fallback.
  const timeFrom = `${yr}-01-01`;
  const timeTo   = `${yr}-12-31`;

  try {
    // ── Get token ──────────────────────────────────────────────────────────
    const token      = await getCDSEToken(clientId, clientSecret);
    const instanceId = getInstanceId(clientId);

    // ── Build CDSE WMS URL ─────────────────────────────────────────────────
    // CRITICAL: instance ID must be in the path, not a query param
    const wmsUrl = new URL(
      `https://sh.dataspace.copernicus.eu/ogc/wms/${encodeURIComponent(instanceId)}`
    );
    wmsUrl.searchParams.set('REQUEST',  'GetMap');
    wmsUrl.searchParams.set('VERSION',  '1.3.0');
    wmsUrl.searchParams.set('SERVICE',  'WMS');
    wmsUrl.searchParams.set('LAYERS',   layer);
    wmsUrl.searchParams.set('FORMAT',   'image/jpeg');
    wmsUrl.searchParams.set('CRS',      'EPSG:3857');
    wmsUrl.searchParams.set('WIDTH',    String(w));
    wmsUrl.searchParams.set('HEIGHT',   String(h));
    wmsUrl.searchParams.set('TIME',     `${timeFrom}/${timeTo}`);
    wmsUrl.searchParams.set('MAXCC',    '30');  // max 30% cloud cover
    wmsUrl.searchParams.set('BBOX',     bbox);

    // ── Fetch tile from CDSE ───────────────────────────────────────────────
    const tileRes = await fetch(wmsUrl.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'image/jpeg,image/*,*/*',
      },
    });

    if (!tileRes.ok) {
      const errText = await tileRes.text();
      console.error(`[sentinel-tile-proxy] CDSE WMS error ${tileRes.status}:`, errText.substring(0, 500));
      return res.status(tileRes.status).json({
        error: 'CDSE WMS error',
        status: tileRes.status,
        layer,
        year: yr,
        detail: errText.substring(0, 200),
      });
    }

    // ── Stream tile back to browser ────────────────────────────────────────
    const contentType = tileRes.headers.get('content-type') || 'image/jpeg';
    const tileBuffer  = await tileRes.arrayBuffer();

    res.setHeader('Content-Type',  contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('X-Sentinel-Layer', layer);
    res.setHeader('X-Sentinel-Year',  String(yr));
    return res.status(200).send(Buffer.from(tileBuffer));

  } catch (err) {
    console.error('[sentinel-tile-proxy] error:', err.message);
    return res.status(500).json({
      error: 'Tile proxy error',
      detail: err.message,
    });
  }
}