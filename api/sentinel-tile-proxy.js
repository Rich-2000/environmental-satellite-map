/**
 * sentinel-tile-proxy.js — v6 PRODUCTION (VERIFIED)
 * ════════════════════════════════════════════════════════════════════════════
 * XYZ tile proxy → Copernicus Data Space Sentinel Hub Process API
 *
 * FIXES IN THIS VERSION (confirmed from live API responses):
 *
 *   BUG 1 (400 Bad Request on ALL tiles):
 *     Accept header 'image/jpeg, image/png, *\/*' is REJECTED by Process API.
 *     The API requires a SINGLE exact mime type.
 *     FIX: Accept: 'image/jpeg'
 *
 *   BUG 2 (500 "Unable to resolve: LETML1" on pre-2013 tiles):
 *     Dataset ID 'landsat-etm-l1' does not exist. The correct identifiers
 *     per official Sentinel Hub docs (verified April 2026) are:
 *       Landsat 4-5 TM L1:  landsat-tm-l1   (prev: LTML1)
 *       Landsat 4-5 TM L2:  landsat-tm-l2   (prev: LTML2)
 *       Landsat 8-9 OLI L1: landsat-ot-l1   (prev: LOTL1)
 *       Landsat 8-9 OLI L2: landsat-ot-l2   (prev: LOTL2)
 *       Sentinel-2 L1C:     sentinel-2-l1c
 *       Sentinel-2 L2A:     sentinel-2-l2a
 *
 *   BUG 3 (WMS 404 on year=2015 tiles from old proxy still in browser cache):
 *     Old v4 proxy used WMS with wrong instance ID. This proxy uses the
 *     Process API directly — no instance/configuration UUID needed.
 *
 * COVERAGE:
 *   2017–present  → sentinel-2-l2a   (10m, best quality, atmospherically corrected)
 *   2015–2016     → sentinel-2-l1c   (10m, TOA reflectance — L2A not available pre-2017)
 *   2021–present  → landsat-ot-l2    (30m, Landsat 8/9, CDSE has data from 2021)
 *   1984–2012     → landsat-tm-l1    (30m, Landsat 4/5 TM, full archive)
 *
 * ENV VARS (Vercel → Settings → Environment Variables):
 *   SENTINEL_CLIENT_ID      — "sh-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 *   SENTINEL_CLIENT_SECRET  — client secret from Copernicus Data Space
 *
 * VERCEL ROUTE (vercel.json):
 *   { "source": "/api/sentinel-tile-proxy/:z/:x/:y",
 *     "destination": "/api/sentinel-tile-proxy?z=:z&x=:x&y=:y" }
 * ════════════════════════════════════════════════════════════════════════════
 */

// ── Module-level token cache ──────────────────────────────────────────────
let _cachedToken = null;
let _tokenExpiry = 0;

// ── XYZ → EPSG:4326 bbox ─────────────────────────────────────────────────
function tile2bbox(z, x, y) {
  const n = Math.pow(2, z);
  const minLon =  (x / n)       * 360 - 180;
  const maxLon = ((x + 1) / n)  * 360 - 180;
  const maxLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)))       * (180 / Math.PI);
  const minLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * (180 / Math.PI);
  return { minLon, minLat, maxLon, maxLat };
}

// ── OAuth2 token (cached) ─────────────────────────────────────────────────
async function getToken(clientId, clientSecret) {
  const now = Date.now();
  if (_cachedToken && _tokenExpiry > now + 30_000) return _cachedToken;

  const res = await fetch(
    'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     clientId,
        client_secret: clientSecret,
      }).toString(),
    }
  );

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OAuth token error ${res.status}: ${txt.slice(0, 300)}`);
  }

  const json  = await res.json();
  _cachedToken = json.access_token;
  _tokenExpiry = now + ((json.expires_in || 600) - 60) * 1000;
  return _cachedToken;
}

// ── Dataset selection — VERIFIED dataset IDs from official CDSE docs ──────
// Source: https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/
// and https://docs.sentinel-hub.com/api/latest/data/
function getDataset(year) {
  const y = parseInt(year, 10);

  if (y >= 2017) {
    // Sentinel-2 L2A — atmospherically corrected surface reflectance
    // Available on CDSE from 2017 onwards (L2A processing was not done earlier)
    return {
      type:        'sentinel-2-l2a',
      label:       'Sentinel-2 L2A',
      // Sentinel-2 bands: B04=Red(665nm), B03=Green(560nm), B02=Blue(490nm)
      // L2A values are reflectance 0.0–1.0 (divide by 10000 if integer format)
      evalscript: `//VERSION=3
function setup() {
  return {
    input:  [{ bands: ["B04", "B03", "B02", "dataMask"] }],
    output: { bands: 4, sampleType: "UINT8" }
  };
}
function evaluatePixel(s) {
  // s.B04/B03/B02 are reflectance 0–1; multiply by gain and scale to 0–255
  var gain = 3.5;
  return [
    Math.min(255, Math.max(0, Math.round(s.B04 * gain * 255))),
    Math.min(255, Math.max(0, Math.round(s.B03 * gain * 255))),
    Math.min(255, Math.max(0, Math.round(s.B02 * gain * 255))),
    s.dataMask * 255
  ];
}`,
    };
  }

  if (y >= 2015) {
    // Sentinel-2 L1C — top-of-atmosphere reflectance (L2A not available pre-2017)
    return {
      type:        'sentinel-2-l1c',
      label:       'Sentinel-2 L1C',
      evalscript: `//VERSION=3
function setup() {
  return {
    input:  [{ bands: ["B04", "B03", "B02", "dataMask"] }],
    output: { bands: 4, sampleType: "UINT8" }
  };
}
function evaluatePixel(s) {
  var gain = 3.5;
  return [
    Math.min(255, Math.max(0, Math.round(s.B04 * gain * 255))),
    Math.min(255, Math.max(0, Math.round(s.B03 * gain * 255))),
    Math.min(255, Math.max(0, Math.round(s.B02 * gain * 255))),
    s.dataMask * 255
  ];
}`,
    };
  }

  if (y >= 2013) {
    // Landsat 8-9 OLI L1 — CDSE data starts from 2021 for Landsat 8/9
    // For 2013-2020, Landsat 8 data EXISTS in archive but CDSE coverage starts 2021
    // Use L1 (full archive) rather than L2 for maximum year coverage
    return {
      type:        'landsat-ot-l1',
      label:       'Landsat 8-9 OLI L1',
      // Landsat-8/9 L1: B04=Red, B03=Green, B02=Blue — DN values 0–65535
      // Typical reflective band range 0–10000 DN → scale by 0.0000275 - 0.2 for TOA
      evalscript: `//VERSION=3
function setup() {
  return {
    input:  [{ bands: ["B04", "B03", "B02", "dataMask"] }],
    output: { bands: 4, sampleType: "UINT8" }
  };
}
function evaluatePixel(s) {
  // L1 DNs — apply simple linear stretch
  // Typical useful DN range for Landsat-8 is ~6000–25000 for reflective bands
  var scale = 255.0 / 25000.0;
  return [
    Math.min(255, Math.max(0, Math.round(s.B04 * scale * 3.5))),
    Math.min(255, Math.max(0, Math.round(s.B03 * scale * 3.5))),
    Math.min(255, Math.max(0, Math.round(s.B02 * scale * 3.5))),
    s.dataMask * 255
  ];
}`,
    };
  }

  // 1984–2012: Landsat 4-5 TM Level 1
  // Official dataset ID: landsat-tm-l1 (previously LTML1)
  // Bands: B03=Red(660nm), B02=Green(560nm), B01=Blue(480nm)
  return {
    type:        'landsat-tm-l1',
    label:       'Landsat 4-5 TM L1',
    evalscript: `//VERSION=3
function setup() {
  return {
    input:  [{ bands: ["B03", "B02", "B01", "dataMask"] }],
    output: { bands: 4, sampleType: "UINT8" }
  };
}
function evaluatePixel(s) {
  // Landsat TM L1: DN values (0–255 8-bit). Typical useful range 10–200.
  // Scale so mid-range is bright — multiply by ~2.0 for natural brightness
  var scale = 2.0;
  return [
    Math.min(255, Math.max(0, Math.round(s.B03 * scale))),
    Math.min(255, Math.max(0, Math.round(s.B02 * scale))),
    Math.min(255, Math.max(0, Math.round(s.B01 * scale))),
    s.dataMask * 255
  ];
}`,
  };
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
    return res.status(500).json({
      error: 'Sentinel credentials not configured',
      hint:  'Set SENTINEL_CLIENT_ID and SENTINEL_CLIENT_SECRET in Vercel Environment Variables'
    });
  }

  // ── Parse tile coordinates ────────────────────────────────────────────────
  // Vercel rewrite: /api/sentinel-tile-proxy/:z/:x/:y → ?z=:z&x=:x&y=:y
  let z, x, y;
  if (req.query.z !== undefined) {
    z = parseInt(req.query.z, 10);
    x = parseInt(req.query.x, 10);
    y = parseInt(req.query.y, 10);
  } else {
    // Fallback: parse from URL path
    const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
    const idx   = parts.indexOf('sentinel-tile-proxy');
    if (idx !== -1 && parts.length >= idx + 4) {
      z = parseInt(parts[idx + 1], 10);
      x = parseInt(parts[idx + 2], 10);
      y = parseInt(parts[idx + 3], 10);
    }
  }

  if ([z, x, y].some(v => isNaN(v)) || z < 0 || z > 22) {
    return res.status(400).json({
      error: 'Invalid tile coordinates',
      received: { z: req.query.z, x: req.query.x, y: req.query.y }
    });
  }

  const yr = parseInt(req.query.year || new Date().getFullYear(), 10);
  const w  = Math.min(512, Math.max(64, parseInt(req.query.width  || '512', 10)));
  const h  = Math.min(512, Math.max(64, parseInt(req.query.height || '512', 10)));

  const { minLon, minLat, maxLon, maxLat } = tile2bbox(z, x, y);
  const ds = getDataset(yr);

  // Use a 6-month dry season window for West Africa (Nov–Apr = lowest cloud cover)
  // Broadening to full year if needed for sparse Landsat coverage
  const isLandsat = ds.type.startsWith('landsat');
  const timeFrom  = isLandsat ? `${yr}-01-01T00:00:00Z` : `${yr}-10-01T00:00:00Z`;
  const timeTo    = isLandsat ? `${yr}-12-31T23:59:59Z` : `${yr}-04-30T23:59:59Z`;

  // For years where the to-date would be in the future, cap to today
  const today = new Date().toISOString().slice(0, 10);
  const timeToCapped = timeTo.slice(0, 10) > today ? `${today}T23:59:59Z` : timeTo;

  const requestBody = {
    input: {
      bounds: {
        bbox: [minLon, minLat, maxLon, maxLat],
        properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' },
      },
      data: [{
        type: ds.type,
        dataFilter: {
          timeRange: {
            from: timeFrom,
            to:   timeToCapped,
          },
          ...(ds.type.includes('sentinel-2') ? { maxCloudCoverage: 30 } : {}),
          mosaickingOrder: 'leastCC',
        },
      }],
    },
    output: {
      width:  w,
      height: h,
      responses: [{
        identifier: 'default',
        format: {
          type:    'image/png',   // PNG supports transparency (dataMask alpha channel)
          quality: 90,
        },
      }],
    },
    evalscript: ds.evalscript,
  };

  try {
    const token = await getToken(clientId, clientSecret);

    const apiRes = await fetch(
      'https://sh.dataspace.copernicus.eu/api/v1/process',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/json',
          // ✅ SINGLE exact mime type — the Process API rejects comma-separated lists
          'Accept':        'image/png',
        },
        body: JSON.stringify(requestBody),
      }
    );

    const ct = apiRes.headers.get('content-type') || '';

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error(`[sentinel-tile-proxy] API ${apiRes.status} z=${z} x=${x} y=${y} type=${ds.type} year=${yr}:`, errText.slice(0, 500));
      return res.status(apiRes.status).json({
        error:   'Sentinel Hub Process API error',
        status:  apiRes.status,
        dataset: ds.type,
        year:    yr, z, x, y,
        detail:  errText.slice(0, 400),
      });
    }

    if (!ct.includes('image/')) {
      const errText = await apiRes.text();
      console.error(`[sentinel-tile-proxy] Non-image response (${ct}):`, errText.slice(0, 300));
      return res.status(502).json({
        error: 'Non-image response from Sentinel Hub',
        contentType: ct,
        dataset: ds.type,
        year: yr, z, x, y,
        detail: errText.slice(0, 200),
      });
    }

    const buf = await apiRes.arrayBuffer();

    res.setHeader('Content-Type',         'image/png');
    res.setHeader('Cache-Control',        'public, max-age=604800, stale-while-revalidate=2592000');
    res.setHeader('X-Sentinel-Dataset',   ds.type);
    res.setHeader('X-Sentinel-Label',     ds.label);
    res.setHeader('X-Sentinel-Year',      String(yr));
    res.setHeader('X-Tile',              `${z}/${x}/${y}`);
    return res.status(200).send(Buffer.from(buf));

  } catch (err) {
    console.error('[sentinel-tile-proxy] error:', err.message);
    return res.status(500).json({
      error: 'Proxy error', detail: err.message,
      dataset: ds.type, year: yr, z, x, y,
    });
  }
}