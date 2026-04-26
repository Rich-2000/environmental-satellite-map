/**
 * api/sentinel-tile-proxy.js  — v8 PRODUCTION
 * ════════════════════════════════════════════════════════════════════════════
 * Sentinel Hub Process API tile proxy for MapLibre GL.
 *
 * KEY FIXES in v8 vs v7:
 *   1. Sends X-Sentinel-Status header on every response so the frontend health
 *      check can distinguish real imagery from fallback transparents.
 *      Values: 'ok' | 'no-credentials' | 'auth-failed' | 'no-data' | 'error'
 *   2. sendTransparent now accepts a status param to set the right header.
 *
 * URL (query-params only — Vercel rewrites drop path params):
 *   /api/sentinel-tile-proxy?z={z}&x={x}&y={y}&year=2022&width=512&height=512
 *
 * ENV VARS (Vercel → Settings → Environment Variables):
 *   SENTINEL_CLIENT_ID      — "sh-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 *   SENTINEL_CLIENT_SECRET  — your CDSE OAuth client secret
 */

let _cachedToken = null;
let _tokenExpiry = 0;

function tile2bbox(z, x, y) {
  const n      = Math.pow(2, z);
  const minLon = (x / n) * 360 - 180;
  const maxLon = ((x + 1) / n) * 360 - 180;
  const maxLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const minLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return { minLon, minLat, maxLon, maxLat };
}

async function getCDSEToken(clientId, clientSecret) {
  const now = Date.now();
  if (_cachedToken && _tokenExpiry > now + 30_000) return _cachedToken;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
  const res = await fetch('https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  if (!res.ok) throw new Error(`CDSE token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  _cachedToken = data.access_token;
  _tokenExpiry = now + ((data.expires_in || 600) - 60) * 1000;
  return _cachedToken;
}

const EVAL_S2 = `//VERSION=3
function setup(){return{input:[{bands:["B02","B03","B04","dataMask"],units:"DN"}],output:{bands:4,sampleType:"UINT8"}};}
function evaluatePixel(s){
  if(!s.dataMask)return[0,0,0,0];
  var g=3.5;
  return[Math.round(Math.min(s.B04/1e4*g,1)*255),Math.round(Math.min(s.B03/1e4*g,1)*255),Math.round(Math.min(s.B02/1e4*g,1)*255),255];
}`;

const EVAL_OLI = `//VERSION=3
function setup(){return{input:[{bands:["B04","B03","B02","dataMask"],units:"DN"}],output:{bands:4,sampleType:"UINT8"}};}
function evaluatePixel(s){
  if(!s.dataMask)return[0,0,0,0];
  var g=3.0;
  return[Math.round(Math.min(s.B04/1e4*g,1)*255),Math.round(Math.min(s.B03/1e4*g,1)*255),Math.round(Math.min(s.B02/1e4*g,1)*255),255];
}`;

const EVAL_TM = `//VERSION=3
function setup(){return{input:[{bands:["B03","B02","B01","dataMask"],units:"DN"}],output:{bands:4,sampleType:"UINT8"}};}
function evaluatePixel(s){
  if(!s.dataMask)return[0,0,0,0];
  var g=3.0;
  return[Math.round(Math.min(s.B03/1e4*g,1)*255),Math.round(Math.min(s.B02/1e4*g,1)*255),Math.round(Math.min(s.B01/1e4*g,1)*255),255];
}`;

function getDataset(year) {
  const y = parseInt(year, 10);
  if (isNaN(y) || y >= 2015) return { type: 'sentinel-2-l2a',  evalscript: EVAL_S2,  label: 'S2-L2A',    maxCC: 30 };
  if (y >= 2013)             return { type: 'landsat-ot-l2',   evalscript: EVAL_OLI, label: 'L8-OLI-L2', maxCC: 40 };
                             return { type: 'landsat-tm-l1',   evalscript: EVAL_TM,  label: 'L45-TM-L1', maxCC: 50 };
}

// Dry-season windows for Accra/Ghana (harmattan = Nov–Mar, minimal cloud cover).
function getDateWindows(yrN) {
  const now      = new Date();
  const thisYear = now.getFullYear();
  if (yrN >= thisYear) {
    const safe = new Date(now.getTime() - 30 * 86400000);
    return [{ from: `${yrN}-01-01T00:00:00Z`, to: safe.toISOString().split('T')[0] + 'T23:59:59Z' }];
  }
  return [
    { from: `${yrN}-12-01T00:00:00Z`, to: `${yrN}-12-31T23:59:59Z` },
    { from: `${yrN}-01-01T00:00:00Z`, to: `${yrN}-02-28T23:59:59Z` },
    { from: `${yrN}-11-01T00:00:00Z`, to: `${yrN}-11-30T23:59:59Z` },
    { from: `${yrN}-03-01T00:00:00Z`, to: `${yrN}-03-31T23:59:59Z` },
    { from: `${yrN}-01-01T00:00:00Z`, to: `${yrN}-12-31T23:59:59Z` },
  ];
}

const TRANSPARENT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function sendTransparent(res, label, yr, z, x, y, status = 'no-data') {
  console.log(`[tile-proxy] transparent(${status}): ${label} ${yr} ${z}/${x}/${y}`);
  res.setHeader('Content-Type',        'image/png');
  res.setHeader('Cache-Control',       'public, max-age=3600');
  res.setHeader('X-No-Data',           'true');
  res.setHeader('X-Sentinel-Status',   status);
  return res.status(200).send(TRANSPARENT_PNG);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const clientId     = process.env.SENTINEL_CLIENT_ID;
  const clientSecret = process.env.SENTINEL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const missing = [!clientId ? 'SENTINEL_CLIENT_ID' : null, !clientSecret ? 'SENTINEL_CLIENT_SECRET' : null].filter(Boolean).join(', ');
    // Return transparent tile (not JSON error) so MapLibre doesn't break —
    // but set X-Sentinel-Status so the health check knows why.
    res.setHeader('X-Sentinel-Status', 'no-credentials');
    res.setHeader('X-Missing-Vars', missing);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(TRANSPARENT_PNG);
  }

  let z = parseInt(req.query.z, 10);
  let x = parseInt(req.query.x, 10);
  let y = parseInt(req.query.y, 10);

  if (isNaN(z)) {
    const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
    const idx   = parts.findIndex(p => p === 'sentinel-tile-proxy');
    if (idx !== -1 && parts.length >= idx + 4) {
      z = parseInt(parts[idx + 1], 10); x = parseInt(parts[idx + 2], 10); y = parseInt(parts[idx + 3], 10);
    }
  }

  if (isNaN(z) || isNaN(x) || isNaN(y) || z < 0 || z > 22) {
    return res.status(400).json({ error: 'Invalid tile coords. Use ?z=N&x=N&y=N', received: { z: req.query.z, x: req.query.x, y: req.query.y } });
  }

  const yr   = req.query.year || String(new Date().getFullYear());
  const w    = Math.min(512, Math.max(64, parseInt(req.query.width  || '512', 10)));
  const h    = Math.min(512, Math.max(64, parseInt(req.query.height || '512', 10)));
  const ds   = getDataset(yr);
  const yrN  = parseInt(yr, 10) || new Date().getFullYear();
  const bbox = tile2bbox(z, x, y);

  let token;
  try {
    token = await getCDSEToken(clientId, clientSecret);
  } catch (authErr) {
    _cachedToken = null; _tokenExpiry = 0;
    console.error('[tile-proxy] Auth error:', authErr.message);
    return sendTransparent(res, ds.label, yrN, z, x, y, 'auth-failed');
  }

  for (const win of getDateWindows(yrN)) {
    let r;
    try {
      r = await fetch('https://sh.dataspace.copernicus.eu/api/v1/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Accept': 'image/png,image/*,*/*' },
        body: JSON.stringify({
          input: {
            bounds: { bbox: [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat], properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } },
            data: [{ type: ds.type, dataFilter: { timeRange: { from: win.from, to: win.to }, maxCloudCoverage: ds.maxCC, mosaickingOrder: 'leastCC' } }],
          },
          output: { width: w, height: h, responses: [{ identifier: 'default', format: { type: 'image/png' } }] },
          evalscript: ds.evalscript,
        }),
      });
    } catch (fetchErr) {
      console.error(`[tile-proxy] fetch error:`, fetchErr.message);
      return sendTransparent(res, ds.label, yrN, z, x, y, 'error');
    }

    if (r.status === 401 || r.status === 403) {
      _cachedToken = null; _tokenExpiry = 0;
      const txt = await r.text().catch(() => '');
      console.error(`[tile-proxy] Auth ${r.status}:`, txt.slice(0, 200));
      return sendTransparent(res, ds.label, yrN, z, x, y, 'auth-failed');
    }

    if (r.status === 400 || r.status === 422) {
      console.log(`[tile-proxy] No data (${r.status}): ${ds.label} yr=${yrN} win=${win.from.slice(0,10)}→${win.to.slice(0,10)} tile=${z}/${x}/${y}`);
      continue; // try next window
    }

    if (!r.ok) {
      console.warn(`[tile-proxy] CDSE ${r.status}: ${ds.label} yr=${yrN} win=${win.from.slice(0,10)}`);
      continue;
    }

    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('image/')) {
      const txt = await r.text().catch(() => '');
      console.error(`[tile-proxy] Non-image (${ct}):`, txt.slice(0, 200));
      continue;
    }

    const buf = await r.arrayBuffer();
    const pu  = r.headers.get('x-processingunits-spent') || '?';
    console.log(`[tile-proxy] ✓ ${ds.label} yr=${yrN} z=${z}/${x}/${y} win=${win.from.slice(0,10)} PU:${pu} bytes:${buf.byteLength}`);

    res.setHeader('Content-Type',        'image/png');
    res.setHeader('Cache-Control',       'public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('X-Dataset',           ds.label);
    res.setHeader('X-Year',              String(yrN));
    res.setHeader('X-PU-Spent',          pu);
    res.setHeader('X-Sentinel-Status',   'ok');   // ← CRITICAL: tells health check imagery is real
    return res.status(200).send(Buffer.from(buf));
  }

  // All windows exhausted — no imagery found for this tile/year
  console.log(`[tile-proxy] All windows exhausted: ${ds.label} yr=${yrN} ${z}/${x}/${y}`);
  return sendTransparent(res, ds.label, yrN, z, x, y, 'no-data');
}