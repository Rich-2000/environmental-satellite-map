/**
 * sentinel-tile-proxy.js — PRODUCTION v6
 * ═══════════════════════════════════════════════════════════════════════════
 * XYZ satellite tile proxy using Sentinel Hub PROCESS API.
 *
 * DEPLOYMENT: place this file at  api/sentinel-tile-proxy.js
 * ROUTE:      GET /api/sentinel-tile-proxy/[z]/[x]/[y]?year=2010
 *
 * WHY PROCESS API (not WMS):
 *   WMS needs a Configuration Instance ID (e.g. "9d559abc…") — a separate
 *   UUID from your OAuth client_id ("sh-xxxx…"). Using client_id in the WMS
 *   path → HTTP 404 on every tile. The Process API uses a Bearer token only.
 *
 * SATELLITE COVERAGE:
 *   2015–present  →  sentinel-2-l2a  (10 m, ESA Copernicus)
 *   2013–2014     →  landsat-ot-l2   (Landsat-8 OLI, 30 m)
 *   1984–2012     →  landsat-tm-l1   (Landsat-4/5 TM, 30 m)
 *
 * ENV VARS (Vercel → Settings → Environment Variables):
 *   SENTINEL_CLIENT_ID      = sh-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 *   SENTINEL_CLIENT_SECRET  = your CDSE OAuth client secret
 */

let _token = null;
let _tokenExpiry = 0;

function tile2bbox(z, x, y) {
  const n = Math.pow(2, z);
  const west  = (x / n) * 360 - 180;
  const east  = ((x + 1) / n) * 360 - 180;
  const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return [west, south, east, north];
}

async function getToken(clientId, clientSecret) {
  if (_token && _tokenExpiry > Date.now() + 30000) return _token;
  const res = await fetch(
    'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    }
  );
  if (!res.ok) throw new Error(`CDSE auth ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  _token = d.access_token;
  _tokenExpiry = Date.now() + ((d.expires_in || 600) - 60) * 1000;
  return _token;
}

function getDataset(year) {
  const y = parseInt(year, 10) || new Date().getFullYear();
  if (y >= 2015) {
    return {
      collection: 'sentinel-2-l2a',
      maxCC: 20,
      evalscript: `//VERSION=3
function setup(){return{input:[{bands:["B02","B03","B04","dataMask"],units:"DN"}],output:{bands:4,sampleType:"UINT8"}};}
function evaluatePixel(s){var g=3.5,v=function(b){return Math.round(Math.min(b/10000*g,1)*255);};return[v(s.B04),v(s.B03),v(s.B02),s.dataMask?255:0];}`,
    };
  }
  if (y >= 2013) {
    return {
      collection: 'landsat-ot-l2',
      maxCC: 30,
      evalscript: `//VERSION=3
function setup(){return{input:[{bands:["B04","B03","B02","dataMask"],units:"DN"}],output:{bands:4,sampleType:"UINT8"}};}
function evaluatePixel(s){var g=3.0,v=function(b){return Math.round(Math.min(b/10000*g,1)*255);};return[v(s.B04),v(s.B03),v(s.B02),s.dataMask?255:0];}`,
    };
  }
  return {
    collection: 'landsat-tm-l1',
    maxCC: 40,
    evalscript: `//VERSION=3
function setup(){return{input:[{bands:["B03","B02","B01","dataMask"],units:"DN"}],output:{bands:4,sampleType:"UINT8"}};}
function evaluatePixel(s){var g=3.0,v=function(b){return Math.round(Math.min(b/10000*g,1)*255);};return[v(s.B03),v(s.B02),v(s.B01),s.dataMask?255:0];}`,
  };
}

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjkB6QAAAABJRU5ErkJggg==',
  'base64'
);

function sendTransparent(res, year, source) {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('X-Sentinel-Year', String(year));
  res.setHeader('X-Sentinel-Source', source || 'no-data');
  res.setHeader('X-No-Data', 'true');
  return res.status(200).send(TRANSPARENT_PNG);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const CLIENT_ID     = process.env.SENTINEL_CLIENT_ID;
  const CLIENT_SECRET = process.env.SENTINEL_CLIENT_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({
      error: 'Missing SENTINEL_CLIENT_ID or SENTINEL_CLIENT_SECRET in Vercel environment variables'
    });
  }

  // Parse z/x/y — supports both query params (from Vercel rewrite) and path parsing
  let z, x, y;
  if (req.query.z !== undefined && req.query.x !== undefined && req.query.y !== undefined) {
    z = parseInt(req.query.z, 10);
    x = parseInt(req.query.x, 10);
    y = parseInt(req.query.y, 10);
  } else {
    const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
    const idx = parts.indexOf('sentinel-tile-proxy');
    if (idx !== -1 && parts.length > idx + 3) {
      z = parseInt(parts[idx + 1], 10);
      x = parseInt(parts[idx + 2], 10);
      y = parseInt(parts[idx + 3], 10);
    }
  }

  if ([z, x, y].some(n => isNaN(n) || n < 0) || z > 22) {
    return res.status(400).json({
      error: 'Invalid tile coordinates',
      hint: 'URL format: /api/sentinel-tile-proxy/{z}/{x}/{y}?year=YYYY',
      received: { z, x, y },
    });
  }

  const year = parseInt(req.query.year || new Date().getFullYear(), 10);
  const ds   = getDataset(year);
  const bbox = tile2bbox(z, x, y); // [west, south, east, north]

  const processBody = {
    input: {
      bounds: {
        bbox: bbox,
        properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' },
      },
      data: [{
        type: ds.collection,
        dataFilter: {
          timeRange: {
            from: `${year}-01-01T00:00:00Z`,
            to:   `${year}-12-31T23:59:59Z`,
          },
          maxCloudCoverage: ds.maxCC,
          mosaickingOrder:  'leastCC',
        },
      }],
    },
    output: {
      width:     256,
      height:    256,
      responses: [{ identifier: 'default', format: { type: 'image/png' } }],
    },
    evalscript: ds.evalscript,
  };

  try {
    let token;
    try {
      token = await getToken(CLIENT_ID, CLIENT_SECRET);
    } catch (authErr) {
      console.error('[sentinel-tile-proxy] Auth failed:', authErr.message);
      return res.status(502).json({
        error: 'Sentinel Hub authentication failed',
        detail: authErr.message,
        hint: 'Check SENTINEL_CLIENT_ID and SENTINEL_CLIENT_SECRET. Regenerate at https://dataspace.copernicus.eu → User Settings → OAuth Clients',
      });
    }

    console.log(`[sentinel-tile-proxy] ${ds.collection} year=${year} z=${z}/${x}/${y}`);

    const apiRes = await fetch('https://sh.dataspace.copernicus.eu/api/v1/process', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
        'Accept':        'image/png,image/*',
      },
      body: JSON.stringify(processBody),
    });

    // Auth error — clear token so next request retries
    if (apiRes.status === 401 || apiRes.status === 403) {
      _token = null;
      _tokenExpiry = 0;
      const txt = await apiRes.text().catch(() => '');
      console.error(`[sentinel-tile-proxy] Auth ${apiRes.status}:`, txt.slice(0, 200));
      return res.status(apiRes.status).json({
        error: 'Sentinel Hub rejected access token',
        detail: txt.slice(0, 200),
        hint: 'SENTINEL_CLIENT_ID/SENTINEL_CLIENT_SECRET may be expired.',
      });
    }

    // No imagery data for this tile+year → return transparent (keeps map clean)
    if (apiRes.status === 400 || apiRes.status === 422) {
      const txt = await apiRes.text().catch(() => '');
      console.log(`[sentinel-tile-proxy] No data (${apiRes.status}) year=${year} z=${z}/${x}/${y}`, txt.slice(0, 100));
      return sendTransparent(res, year, ds.collection);
    }

    // Any other non-OK response → transparent tile (don't crash the map)
    if (!apiRes.ok) {
      const txt = await apiRes.text().catch(() => '');
      console.error(`[sentinel-tile-proxy] API ${apiRes.status} year=${year}:`, txt.slice(0, 150));
      return sendTransparent(res, year, ds.collection);
    }

    // If we got a non-image content type → transparent tile
    const ct = apiRes.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) {
      const txt = await apiRes.text().catch(() => '');
      console.error(`[sentinel-tile-proxy] Non-image response (${ct}):`, txt.slice(0, 150));
      return sendTransparent(res, year, ds.collection);
    }

    // Success — stream image tile back to MapLibre
    const buf = Buffer.from(await apiRes.arrayBuffer());
    const pu  = apiRes.headers.get('x-processingunits-spent') || '?';
    console.log(`[sentinel-tile-proxy] ✓ ${ds.collection} year=${year} z=${z}/${x}/${y} PU:${pu} bytes:${buf.byteLength}`);

    res.setHeader('Content-Type',      'image/png');
    res.setHeader('Content-Length',    String(buf.byteLength));
    res.setHeader('Cache-Control',     'public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('X-Sentinel-Year',   String(year));
    res.setHeader('X-Sentinel-Source', ds.collection);
    res.setHeader('X-Tile',            `${z}/${x}/${y}`);
    return res.status(200).send(buf);

  } catch (err) {
    console.error('[sentinel-tile-proxy] Unexpected error:', err.message);
    return sendTransparent(res, year, ds ? ds.collection : 'error');
  }
}