/**
 * sentinel-tile-proxy.js  — v5 PRODUCTION (Process API)
 * ════════════════════════════════════════════════════════════════════════════
 * XYZ tile proxy using the Sentinel Hub PROCESS API (not WMS).
 *
 * WHY PROCESS API (not WMS):
 *   - WMS requires a separate "Configuration Instance ID" (e.g. "9d559...")
 *     which is DIFFERENT from your OAuth client_id ("sh-xxxx...").
 *   - Using client_id in the WMS URL path causes 404 on every tile.
 *   - The Process API authenticates with the Bearer token alone — no
 *     instance ID needed, works directly with your SENTINEL_CLIENT_ID +
 *     SENTINEL_CLIENT_SECRET env vars.
 *   - Process API supports historical imagery via TIME parameter.
 *
 * SATELLITE COVERAGE BY YEAR:
 *   2015–present  → Sentinel-2 L2A (10 m resolution, true colour)
 *   2013–2014     → Landsat-8 OLI L2 (30 m, via CDSE Landsat collection)
 *   pre-2013      → Landsat 4/5 TM (30 m, via CDSE Landsat collection)
 *
 * ROUTE:  GET /api/sentinel-tile-proxy/[z]/[x]/[y]?year=2010&layer=TRUE-COLOR
 *
 * ENV VARS (Vercel → Settings → Environment Variables):
 *   SENTINEL_CLIENT_ID      — "sh-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 *   SENTINEL_CLIENT_SECRET  — your CDSE OAuth client secret
 * ════════════════════════════════════════════════════════════════════════════
 */

// ── Module-level token cache ────────────────────────────────────────────────
let _cachedToken = null;
let _tokenExpiry = 0;

// ── Tile → EPSG:4326 bbox conversion ────────────────────────────────────────
function tile2bbox(z, x, y) {
  const n      = Math.pow(2, z);
  const minLon = (x / n) * 360 - 180;
  const maxLon = ((x + 1) / n) * 360 - 180;
  const maxLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const minLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return { minLon, minLat, maxLon, maxLat };
}

// ── OAuth2 token (CDSE identity endpoint) ───────────────────────────────────
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

  const data   = await res.json();
  _cachedToken = data.access_token;
  _tokenExpiry = now + ((data.expires_in || 600) - 60) * 1000;
  return _cachedToken;
}

// ── Evalscripts ─────────────────────────────────────────────────────────────

const EVALSCRIPTS = {
  // Sentinel-2 L2A true colour (2015–present)
  's2-truecolor': `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B02","B03","B04","dataMask"], units: "DN" }],
    output: { bands: 4, sampleType: "UINT8" }
  };
}
function evaluatePixel(s) {
  var gain = 3.5;
  return [
    Math.round(Math.min(s.B04/10000*gain,1)*255),
    Math.round(Math.min(s.B03/10000*gain,1)*255),
    Math.round(Math.min(s.B02/10000*gain,1)*255),
    s.dataMask ? 255 : 0
  ];
}`,

  // Landsat-8/9 OLI true colour (2013–2014 via CDSE)
  'landsat-oli-truecolor': `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04","B03","B02","dataMask"], units: "DN" }],
    output: { bands: 4, sampleType: "UINT8" }
  };
}
function evaluatePixel(s) {
  var gain = 3.0;
  return [
    Math.round(Math.min(s.B04/10000*gain,1)*255),
    Math.round(Math.min(s.B03/10000*gain,1)*255),
    Math.round(Math.min(s.B02/10000*gain,1)*255),
    s.dataMask ? 255 : 0
  ];
}`,

  // Landsat 4/5 TM true colour (pre-2013 via CDSE)
  'landsat-tm-truecolor': `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B03","B02","B01","dataMask"], units: "DN" }],
    output: { bands: 4, sampleType: "UINT8" }
  };
}
function evaluatePixel(s) {
  var gain = 3.0;
  return [
    Math.round(Math.min(s.B03/10000*gain,1)*255),
    Math.round(Math.min(s.B02/10000*gain,1)*255),
    Math.round(Math.min(s.B01/10000*gain,1)*255),
    s.dataMask ? 255 : 0
  ];
}`,
};

// ── Dataset config by year ───────────────────────────────────────────────────
function getDatasetConfig(year) {
  const y = parseInt(year, 10);

  if (y >= 2015) {
    return {
      type:       'sentinel-2-l2a',
      evalscript: EVALSCRIPTS['s2-truecolor'],
      label:      'Sentinel-2 L2A',
      maxCC:       30,
    };
  }

  if (y >= 2013) {
    // Landsat 8 OLI Collection 2, Level-2
    return {
      type:       'landsat-ot-l2',
      evalscript: EVALSCRIPTS['landsat-oli-truecolor'],
      label:      'Landsat-8 OLI L2',
      maxCC:       40,
    };
  }

  // Landsat 4/5 TM via CDSE (ESA-processed, available 1984+)
  return {
    type:       'landsat-tm-l1',
    evalscript: EVALSCRIPTS['landsat-tm-truecolor'],
    label:      'Landsat TM L1',
    maxCC:       50,
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────
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
    return res.status(500).json({ error: 'SENTINEL_CLIENT_ID / SENTINEL_CLIENT_SECRET not configured in Vercel env vars' });
  }

  // ── Parse tile z/x/y ──────────────────────────────────────────────────────
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
      error:    'Invalid or missing tile coordinates (z, x, y)',
      received: { z: req.query.z, x: req.query.x, y: req.query.y },
    });
  }

  // ── Other params ──────────────────────────────────────────────────────────
  const yr = parseInt(req.query.year || new Date().getFullYear(), 10);
  const w  = Math.min(512, Math.max(64, parseInt(req.query.width  || '512', 10)));
  const h  = Math.min(512, Math.max(64, parseInt(req.query.height || '512', 10)));

  // ── Dataset ───────────────────────────────────────────────────────────────
  const ds = getDatasetConfig(yr);

  // ── Tile → geographic bbox ────────────────────────────────────────────────
  const { minLon, minLat, maxLon, maxLat } = tile2bbox(z, x, y);

  // Full-year range for best cloud-free mosaic
  const timeFrom = `${yr}-01-01T00:00:00Z`;
  const timeTo   = `${yr}-12-31T23:59:59Z`;

  // ── Assemble Process API body ─────────────────────────────────────────────
  const processBody = {
    input: {
      bounds: {
        bbox:       [minLon, minLat, maxLon, maxLat],
        properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' },
      },
      data: [
        {
          type: ds.type,
          dataFilter: {
            timeRange:       { from: timeFrom, to: timeTo },
            maxCloudCoverage: ds.maxCC,
            mosaickingOrder: 'leastCC',
          },
        },
      ],
    },
    output: {
      width:     w,
      height:    h,
      responses: [{ identifier: 'default', format: { type: 'image/png' } }],
    },
    evalscript: ds.evalscript,
  };

  try {
    const token = await getCDSEToken(clientId, clientSecret);

    console.log(`[sentinel-tile-proxy] ${ds.label} · year=${yr} · z=${z} x=${x} y=${y}`);

    const processRes = await fetch('https://sh.dataspace.copernicus.eu/api/v1/process', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
        'Accept':        'image/png,image/*,*/*',
      },
      body: JSON.stringify(processBody),
    });

    // Handle 401/403 — clear cached token
    if (processRes.status === 401 || processRes.status === 403) {
      _cachedToken = null;
      _tokenExpiry = 0;
      const errText = await processRes.text();
      console.error(`[sentinel-tile-proxy] Auth error ${processRes.status}:`, errText.slice(0, 300));
      return res.status(processRes.status).json({
        error:  'Sentinel Hub auth failed — check SENTINEL_CLIENT_ID and SENTINEL_CLIENT_SECRET in Vercel env vars',
        detail: errText.slice(0, 200),
      });
    }

    // Handle 4xx/5xx
    if (!processRes.ok) {
      const ct      = processRes.headers.get('content-type') ?? '';
      let errDetail = '';
      try {
        errDetail = ct.includes('json')
          ? JSON.stringify(await processRes.json())
          : (await processRes.text()).slice(0, 400);
      } catch (_) {}

      console.error(`[sentinel-tile-proxy] Process API ${processRes.status} z=${z}/${x}/${y}:`, errDetail.slice(0, 200));

      // No data for this tile/year: return a transparent PNG (keeps map clean)
      if (processRes.status === 400 || processRes.status === 422) {
        return sendTransparentTile(res, ds.label, yr, z, x, y);
      }
      return res.status(processRes.status).json({
        error:  `Sentinel Process API error ${processRes.status}`,
        detail: errDetail.slice(0, 200),
        layer:  ds.label, year: yr, z, x, y,
      });
    }

    // Reject unexpected non-image content-type
    const ct = processRes.headers.get('content-type') ?? '';
    if (!ct.includes('image/')) {
      const errText = await processRes.text();
      console.error(`[sentinel-tile-proxy] Non-image response (${ct}):`, errText.slice(0, 200));
      return sendTransparentTile(res, ds.label, yr, z, x, y);
    }

    // Stream image tile back with generous cache headers
    const buf = await processRes.arrayBuffer();
    const pu  = processRes.headers.get('x-processingunits-spent') ?? '?';
    console.log(`[sentinel-tile-proxy] ✓ ${ds.label} ${yr} z=${z}/${x}/${y} PU:${pu}`);

    res.setHeader('Content-Type',     'image/png');
    res.setHeader('Cache-Control',    'public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('X-Sentinel-Year',  String(yr));
    res.setHeader('X-Sentinel-Layer', ds.label);
    res.setHeader('X-Tile-Coords',    `${z}/${x}/${y}`);
    return res.status(200).send(Buffer.from(buf));

  } catch (err) {
    console.error('[sentinel-tile-proxy] error:', err.message);
    return res.status(500).json({ error: 'Tile proxy error', detail: err.message });
  }
}

// ── Transparent 1×1 PNG fallback (no data for this tile) ────────────────────
function sendTransparentTile(res, label, yr, z, x, y) {
  // Minimal valid 1×1 transparent PNG (67 bytes)
  const transparentPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  console.log(`[sentinel-tile-proxy] No data → transparent tile ${label} ${yr} z=${z}/${x}/${y}`);
  res.setHeader('Content-Type',     'image/png');
  res.setHeader('Cache-Control',    'public, max-age=3600');
  res.setHeader('X-Sentinel-Year',  String(yr));
  res.setHeader('X-Sentinel-Layer', label);
  res.setHeader('X-No-Data',        'true');
  return res.status(200).send(transparentPng);
}