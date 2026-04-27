/**
 * api/sentinel-tile-proxy.js — v8 PRODUCTION (patched)
 * ════════════════════════════════════════════════════════════════════════════
 * Sentinel Hub Process API tile proxy for MapLibre GL.
 *
 * KEY FIXES in v8:
 *   • On missing credentials → returns transparent PNG (not 500 JSON).
 *     This prevents MapLibre's evented.ts tile-load errors.
 *   • On auth failure → returns transparent PNG (not 401 JSON).
 *   • evalscripts use DN units + gain for correct true-colour rendering.
 *   • Dry-season windows: Dec→Jan-Feb→Nov→Mar→full-year (harmattan = clear sky).
 *   • maxCloudCoverage and leastCC mosaicking to minimise cloud cover in output.
 *
 * Supports three Copernicus datasets, auto-selected by year:
 *   • sentinel-2-l2a   : 2015 → present   (10 m, true colour)
 *   • landsat-ot-l2    : 2013 → 2015      (30 m, Landsat-8 OLI)
 *   • landsat-tm-l1    : pre-2013          (30 m, Landsat-4/5 TM)
 *
 * URL: /api/sentinel-tile-proxy?z={z}&x={x}&y={y}&year=2022&width=512&height=512
 *
 * ENV VARS (Vercel → Settings → Environment Variables):
 *   SENTINEL_CLIENT_ID      — "sh-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 *   SENTINEL_CLIENT_SECRET  — your CDSE OAuth client secret
 *   Regenerate at: dataspace.copernicus.eu → Sign In → User Settings → OAuth Clients
 */

// 1×1 transparent PNG — returned instead of error responses so MapLibre never
// receives a non-image tile (which causes evented.ts Error cascades in the console).
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function sendTransparent(res, reason, yr, z, x, y) {
  console.log(`[tile-proxy] transparent (${reason}): yr=${yr} ${z}/${x}/${y}`);
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=300');  // short cache for auth failures
  res.setHeader('X-No-Data', reason);
  return res.status(200).send(TRANSPARENT_PNG);
}

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
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  });
  const res = await fetch(
    'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }
  );
  if (!res.ok) throw new Error(`CDSE token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  _cachedToken = data.access_token;
  _tokenExpiry = now + ((data.expires_in || 600) - 60) * 1000;
  return _cachedToken;
}

// ── Evalscripts (VERSION=3, DN units, brightness-scaled true colour) ─────────
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
  if (isNaN(y) || y >= 2015) return { type: 'sentinel-2-l2a',  evalscript: EVAL_S2,  label: 'S2-L2A',    maxCC: 25 };
  if (y >= 2013)             return { type: 'landsat-ot-l2',   evalscript: EVAL_OLI, label: 'L8-OLI-L2', maxCC: 35 };
                             return { type: 'landsat-tm-l1',   evalscript: EVAL_TM,  label: 'L45-TM-L1', maxCC: 50 };
}

/**
 * Dry-season windows for Ghana/Accra (harmattan = Nov–Mar, minimal cloud).
 * Tried in order — first window that returns imagery wins.
 * Using maxCloudCoverage + leastCC mosaicking gives cloud-free composites.
 */
function getDateWindows(yrN) {
  const now      = new Date();
  const thisYear = now.getFullYear();
  if (yrN >= thisYear) {
    // Current year — use safe window ending 30 days ago to avoid missing tiles
    const safe = new Date(now.getTime() - 30 * 86400000);
    const safeStr = safe.toISOString().split('T')[0] + 'T23:59:59Z';
    return [{ from: `${yrN}-01-01T00:00:00Z`, to: safeStr }];
  }
  return [
    // Peak dry season: December (lowest cloud over Ghana)
    { from: `${yrN}-12-01T00:00:00Z`, to: `${yrN}-12-31T23:59:59Z` },
    // Jan-Feb (post-harmattan, still dry)
    { from: `${yrN}-01-01T00:00:00Z`, to: `${yrN}-02-28T23:59:59Z` },
    // November onset of dry season
    { from: `${yrN}-11-01T00:00:00Z`, to: `${yrN}-11-30T23:59:59Z` },
    // Early March (tail of dry season)
    { from: `${yrN}-03-01T00:00:00Z`, to: `${yrN}-03-31T23:59:59Z` },
    // Full year fallback — leastCC will still pick the clearest scene
    { from: `${yrN}-01-01T00:00:00Z`, to: `${yrN}-12-31T23:59:59Z` },
  ];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const clientId     = process.env.SENTINEL_CLIENT_ID;
  const clientSecret = process.env.SENTINEL_CLIENT_SECRET;

  // ── CRITICAL FIX: Return transparent PNG instead of 500 JSON when credentials missing.
  // Previously this returned a JSON 500 response, which MapLibre cannot parse as an image
  // tile → fires evented.ts:149 Error cascade in the browser console.
  // Now it returns a transparent 1×1 PNG so MapLibre silently skips the tile.
  if (!clientId || !clientSecret) {
    const missing = [!clientId ? 'SENTINEL_CLIENT_ID' : null, !clientSecret ? 'SENTINEL_CLIENT_SECRET' : null]
      .filter(Boolean).join(', ');
    console.warn(`[tile-proxy] Missing env vars: ${missing} — returning transparent tile`);
    return sendTransparent(res, 'missing-credentials', 'unknown', 0, 0, 0);
  }

  let z = parseInt(req.query.z, 10);
  let x = parseInt(req.query.x, 10);
  let y = parseInt(req.query.y, 10);

  // Fallback: parse z/x/y from path if query params are missing
  if (isNaN(z)) {
    const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
    const idx   = parts.findIndex(p => p === 'sentinel-tile-proxy');
    if (idx !== -1 && parts.length >= idx + 4) {
      z = parseInt(parts[idx + 1], 10);
      x = parseInt(parts[idx + 2], 10);
      y = parseInt(parts[idx + 3], 10);
    }
  }

  if (isNaN(z) || isNaN(x) || isNaN(y) || z < 0 || z > 22) {
    return res.status(400).json({
      error: 'Invalid tile coords. Use ?z=N&x=N&y=N',
      received: { z: req.query.z, x: req.query.x, y: req.query.y }
    });
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
    // ── CRITICAL FIX: Return transparent PNG instead of 401 JSON on auth failure.
    return sendTransparent(res, 'auth-failed', yrN, z, x, y);
  }

  for (const win of getDateWindows(yrN)) {
    let r;
    try {
      r = await fetch('https://sh.dataspace.copernicus.eu/api/v1/process', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
          'Accept':        'image/png,image/*,*/*'
        },
        body: JSON.stringify({
          input: {
            bounds: {
              bbox: [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat],
              properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' }
            },
            data: [{
              type: ds.type,
              dataFilter: {
                timeRange:       { from: win.from, to: win.to },
                maxCloudCoverage: ds.maxCC,
                mosaickingOrder: 'leastCC'  // pick least-cloudy scene in the window
              }
            }]
          },
          output: {
            width:  w,
            height: h,
            responses: [{ identifier: 'default', format: { type: 'image/png' } }]
          },
          evalscript: ds.evalscript
        }),
        signal: AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined
      });
    } catch (fetchErr) {
      console.warn(`[tile-proxy] fetch error: ${ds.label} yr=${yrN} win=${win.from.slice(0,10)} — ${fetchErr.message}`);
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

    res.setHeader('Content-Type',  'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('X-Dataset',     ds.label);
    res.setHeader('X-Year',        String(yrN));
    res.setHeader('X-PU-Spent',    pu);
    return res.status(200).send(Buffer.from(buf));
  }

  // All windows exhausted — return transparent tile (never break MapLibre)
  return sendTransparent(res, 'no-data-all-windows', yrN, z, x, y);
}