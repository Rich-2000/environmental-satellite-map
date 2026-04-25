/**
 * sentinel-tile-proxy.js — v5 PRODUCTION (Process API)
 * ════════════════════════════════════════════════════════════════════════════
 * XYZ → Sentinel Hub Process API tile proxy.
 *
 * ROUTE:  GET /api/sentinel-tile-proxy/[z]/[x]/[y]
 *   OR:   GET /api/sentinel-tile-proxy?z=&x=&y=&layer=&year=
 *
 * WHY THIS WAS BROKEN BEFORE (v4):
 *   The v4 proxy used the CDSE WMS endpoint:
 *     https://sh.dataspace.copernicus.eu/ogc/wms/{clientId}
 *   This is WRONG. The WMS path requires a "configuration/instance UUID"
 *   (a GUID you create in the Sentinel Hub Dashboard under Configurations).
 *   The OAuth client_id (sh-xxxx-xxxx-xxxx) is NOT the same as the instance
 *   UUID — passing client_id in the path causes 404 for every tile.
 *
 *   Also, WMS layer names like "TRUE-COLOR" are user-defined inside a
 *   configuration and don't exist globally. Without a configuration UUID and
 *   a named layer inside it, every WMS tile returns 404 or XML errors.
 *
 * THE CORRECT PRODUCTION APPROACH (used by EO Browser, Sentinel Playground):
 *   Use the Sentinel Hub PROCESS API:
 *     POST https://sh.dataspace.copernicus.eu/api/v1/process
 *   This endpoint:
 *     1. Accepts OAuth Bearer token (same credentials you already have)
 *     2. Accepts a bbox + time range + evalscript — NO configuration needed
 *     3. Returns raw, exact, cloud-filtered satellite imagery as JPEG/PNG
 *     4. Supports Sentinel-2 (2015-present), Landsat-8/9 (2013-2014),
 *        and Landsat-5 TM (1984-2012) via different datasetId values
 *
 * HOW IT WORKS NOW:
 *   1. Vercel routes /api/sentinel-tile-proxy/[z]/[x]/[y] here.
 *   2. We convert tile (z,x,y) → EPSG:4326 bounding box.
 *   3. Fetch a cached CDSE OAuth2 token using client credentials.
 *   4. POST to the Process API with the correct datasetId + evalscript.
 *   5. Stream the JPEG tile back with cache headers.
 *
 * DATASET IDs (official Sentinel Hub Process API identifiers):
 *   Sentinel-2 L2A  (2017-present):  SENTINEL-2-L2A
 *   Sentinel-2 L1C  (2015-present):  SENTINEL-2-L1C
 *   Landsat-8/9 OLI (2013-present):  LANDSAT-OT-L2  (Collection 2 Level-2)
 *   Landsat-5 TM    (1984-2012):     LANDSAT-ETM-L1 (older missions)
 *
 * ENV VARS (set in Vercel → Settings → Environment Variables):
 *   SENTINEL_CLIENT_ID      — full "sh-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 *   SENTINEL_CLIENT_SECRET  — client secret from Copernicus Data Space
 * ════════════════════════════════════════════════════════════════════════════
 */

// ── Module-level token cache (survives warm Lambda invocations) ───────────
let _cachedToken = null;
let _tokenExpiry = 0;

// ── Tile math ─────────────────────────────────────────────────────────────
/**
 * Convert XYZ tile coordinates to EPSG:4326 geographic bbox.
 * Returns { minLon, minLat, maxLon, maxLat } in decimal degrees.
 */
function tile2bbox(z, x, y) {
  const n      = Math.pow(2, z);
  const minLon =  (x / n)       * 360 - 180;
  const maxLon = ((x + 1) / n)  * 360 - 180;
  // Mercator latitude — Y axis inverted in tile coords
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
    throw new Error(`CDSE token error ${res.status}: ${txt.slice(0, 400)}`);
  }

  const data   = await res.json();
  _cachedToken = data.access_token;
  _tokenExpiry = now + ((data.expires_in || 600) - 60) * 1000;
  return _cachedToken;
}

// ── Dataset selection ─────────────────────────────────────────────────────
/**
 * Returns the correct Sentinel Hub Process API datasetId for a given year.
 *
 * Official dataset identifiers from Sentinel Hub documentation:
 *   https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data.html
 */
function datasetForYear(year) {
  const y = parseInt(year, 10);
  if (y >= 2017) return { id: 'sentinel-2-l2a',  label: 'Sentinel-2 L2A'      };
  if (y >= 2015) return { id: 'sentinel-2-l1c',  label: 'Sentinel-2 L1C'      };
  if (y >= 2013) return { id: 'landsat-ot-l2',   label: 'Landsat-8/9 OLI L2'  };
  return              { id: 'landsat-etm-l1',  label: 'Landsat-4/5 TM L1'  };
}

// ── True-color evalscript ─────────────────────────────────────────────────
/**
 * Sentinel Hub evalscript for true-color (RGB) output.
 * Works for Sentinel-2 and Landsat — band names differ per dataset.
 * The Process API resolves band names internally per dataset.
 *
 * For Sentinel-2: B04=Red, B03=Green, B02=Blue (10m resolution)
 * For Landsat-8:  B04=Red, B03=Green, B02=Blue (30m resolution)
 * For Landsat-5:  B03=Red, B02=Green, B01=Blue (30m resolution)
 */
function evalscriptForDataset(datasetId) {
  // Landsat-5 TM uses different band numbering
  if (datasetId === 'landsat-etm-l1') {
    return `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B03", "B02", "B01"] }],
    output: { bands: 3, sampleType: "UINT8" }
  };
}
function evaluatePixel(sample) {
  return [
    Math.min(255, Math.max(0, sample.B03 * 3.5 * 255)),
    Math.min(255, Math.max(0, sample.B02 * 3.5 * 255)),
    Math.min(255, Math.max(0, sample.B01 * 3.5 * 255))
  ];
}`;
  }
  // Sentinel-2 and Landsat-8/9: B04=Red, B03=Green, B02=Blue
  return `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B03", "B02"] }],
    output: { bands: 3, sampleType: "UINT8" }
  };
}
function evaluatePixel(sample) {
  // Gamma correction + brightness for natural-looking true colour
  const gain = ${datasetId.startsWith('sentinel') ? '3.5' : '0.0001 * 3.5 * 255'};
  if (typeof gain === 'number' && gain > 100) {
    // Landsat OL2 — reflectance scaled 0–10000
    return [
      Math.min(255, Math.max(0, sample.B04 * 0.00035 * 255)),
      Math.min(255, Math.max(0, sample.B03 * 0.00035 * 255)),
      Math.min(255, Math.max(0, sample.B02 * 0.00035 * 255))
    ];
  }
  return [
    Math.min(255, Math.max(0, sample.B04 * 3.5 * 255)),
    Math.min(255, Math.max(0, sample.B03 * 3.5 * 255)),
    Math.min(255, Math.max(0, sample.B02 * 3.5 * 255))
  ];
}`;
}

// Better evalscript — clean, simple, handles all datasets correctly
function trueColorEvalscript(datasetId) {
  if (datasetId === 'landsat-etm-l1') {
    // Landsat 4/5 TM: Band 3=Red, Band 2=Green, Band 1=Blue, reflectance 0-1
    return `//VERSION=3
function setup() {
  return { input:[{bands:["B03","B02","B01"]}], output:{bands:3,sampleType:"UINT8"} };
}
function evaluatePixel(s) {
  return [
    clamp(s.B03*3.5*255, 0, 255),
    clamp(s.B02*3.5*255, 0, 255),
    clamp(s.B01*3.5*255, 0, 255)
  ];
}
function clamp(v,lo,hi){return v<lo?lo:v>hi?hi:v;}`;
  }
  if (datasetId === 'landsat-ot-l2') {
    // Landsat 8/9 Collection 2 Level-2: Surface Reflectance, scale factor 0.0000275 - 0.2
    return `//VERSION=3
function setup() {
  return { input:[{bands:["B04","B03","B02"]}], output:{bands:3,sampleType:"UINT8"} };
}
function evaluatePixel(s) {
  // SR values stored as integers; true reflectance = value*0.0000275 - 0.2
  var r = s.B04 * 0.0000275 - 0.2;
  var g = s.B03 * 0.0000275 - 0.2;
  var b = s.B02 * 0.0000275 - 0.2;
  return [
    clamp(r * 4.0 * 255, 0, 255),
    clamp(g * 4.0 * 255, 0, 255),
    clamp(b * 4.0 * 255, 0, 255)
  ];
}
function clamp(v,lo,hi){return v<lo?lo:v>hi?hi:v;}`;
  }
  // Sentinel-2 L1C / L2A: reflectance 0-1 (L2A) or TOA (L1C)
  return `//VERSION=3
function setup() {
  return { input:[{bands:["B04","B03","B02"]}], output:{bands:3,sampleType:"UINT8"} };
}
function evaluatePixel(s) {
  return [
    clamp(s.B04 * 3.5 * 255, 0, 255),
    clamp(s.B03 * 3.5 * 255, 0, 255),
    clamp(s.B02 * 3.5 * 255, 0, 255)
  ];
}
function clamp(v,lo,hi){return v<lo?lo:v>hi?hi:v;}`;
}

// ── Main handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // ── CORS ─────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  // ── Credentials ───────────────────────────────────────────────────────────
  const clientId     = process.env.SENTINEL_CLIENT_ID;
  const clientSecret = process.env.SENTINEL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'Sentinel credentials not configured. Set SENTINEL_CLIENT_ID and SENTINEL_CLIENT_SECRET in Vercel Environment Variables.' });
  }

  // ── Parse tile coordinates ────────────────────────────────────────────────
  // Support /api/sentinel-tile-proxy/[z]/[x]/[y] via vercel.json rewrites
  // AND /api/sentinel-tile-proxy?z=&x=&y= query-param fallback
  let z, x, y;

  if (req.query.z !== undefined && req.query.x !== undefined && req.query.y !== undefined) {
    z = parseInt(req.query.z, 10);
    x = parseInt(req.query.x, 10);
    y = parseInt(req.query.y, 10);
  } else {
    const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
    const idx   = parts.indexOf('sentinel-tile-proxy');
    if (idx !== -1 && parts.length >= idx + 4) {
      z = parseInt(parts[idx + 1], 10);
      x = parseInt(parts[idx + 2], 10);
      y = parseInt(parts[idx + 3], 10);
    }
  }

  if (isNaN(z) || isNaN(x) || isNaN(y) || z < 0 || z > 22) {
    return res.status(400).json({
      error: 'Missing or invalid tile coordinates',
      hint:  'Provide z, x, y as path segments (/api/sentinel-tile-proxy/z/x/y) or query params',
      received: { z: req.query.z, x: req.query.x, y: req.query.y, url: req.url }
    });
  }

  // ── Other params ──────────────────────────────────────────────────────────
  const yr  = parseInt(req.query.year || new Date().getFullYear(), 10);
  const w   = Math.min(512, Math.max(64, parseInt(req.query.width  || '512', 10)));
  const h   = Math.min(512, Math.max(64, parseInt(req.query.height || '512', 10)));

  // ── Tile → geographic bbox ────────────────────────────────────────────────
  const { minLon, minLat, maxLon, maxLat } = tile2bbox(z, x, y);

  // ── Dataset + evalscript ──────────────────────────────────────────────────
  const dataset    = datasetForYear(yr);
  const evalscript = trueColorEvalscript(dataset.id);

  // Time range: use narrow 3-month dry season window for clearest imagery
  // Accra dry season: Nov–Feb (lowest cloud cover over West Africa)
  // Broaden to full year if user wants any-time composite
  const timeFrom = `${yr}-10-01`;
  const timeTo   = `${yr}-12-31`;

  // ── Process API request body ──────────────────────────────────────────────
  const requestBody = {
    input: {
      bounds: {
        bbox: [minLon, minLat, maxLon, maxLat],
        properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' }
      },
      data: [
        {
          dataFilter: {
            timeRange: {
              from: `${timeFrom}T00:00:00Z`,
              to:   `${timeTo}T23:59:59Z`,
            },
            maxCloudCoverage: 30,   // skip scenes with >30% cloud cover
            mosaickingOrder: 'leastCC', // use least-cloudy scene on top
          },
          type: dataset.id,
        }
      ]
    },
    output: {
      width:  w,
      height: h,
      responses: [
        {
          identifier: 'default',
          format: { type: 'image/jpeg', quality: 85 }
        }
      ]
    },
    evalscript: evalscript,
  };

  try {
    const token = await getCDSEToken(clientId, clientSecret);

    const processRes = await fetch(
      'https://sh.dataspace.copernicus.eu/api/v1/process',
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/json',
          'Accept':        'image/jpeg, image/png, */*',
        },
        body: JSON.stringify(requestBody),
      }
    );

    const contentType = processRes.headers.get('content-type') || '';

    if (!processRes.ok) {
      const errText = await processRes.text();
      console.error(
        `[sentinel-tile-proxy] Process API ${processRes.status} z=${z} x=${x} y=${y} dataset=${dataset.id} year=${yr}:`,
        errText.slice(0, 500)
      );
      return res.status(processRes.status).json({
        error:   'Sentinel Hub Process API error',
        status:  processRes.status,
        dataset: dataset.id,
        year:    yr,
        z, x, y,
        detail:  errText.slice(0, 300),
      });
    }

    // Guard against non-image responses (e.g. JSON error with 200 status)
    if (!contentType.includes('image/')) {
      const errText = await processRes.text();
      console.error(`[sentinel-tile-proxy] Process API returned non-image: ${contentType}`, errText.slice(0, 300));
      return res.status(502).json({
        error:       'Sentinel Hub returned non-image response',
        contentType,
        dataset:     dataset.id,
        year:        yr,
        z, x, y,
        detail:      errText.slice(0, 200),
      });
    }

    const tileBuffer = await processRes.arrayBuffer();

    res.setHeader('Content-Type',           contentType.split(';')[0].trim() || 'image/jpeg');
    res.setHeader('Cache-Control',          'public, max-age=604800, stale-while-revalidate=2592000');
    res.setHeader('X-Sentinel-Dataset',     dataset.id);
    res.setHeader('X-Sentinel-Label',       dataset.label);
    res.setHeader('X-Sentinel-Year',        String(yr));
    res.setHeader('X-Tile-Coords',          `${z}/${x}/${y}`);
    res.setHeader('X-Tile-Bbox-4326',       `${minLon},${minLat},${maxLon},${maxLat}`);
    return res.status(200).send(Buffer.from(tileBuffer));

  } catch (err) {
    console.error('[sentinel-tile-proxy] error:', err.message);
    return res.status(500).json({
      error:  'Tile proxy error',
      detail: err.message,
      dataset: datasetForYear(yr).id,
      year: yr, z, x, y,
    });
  }
}