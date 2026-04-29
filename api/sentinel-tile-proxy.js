/**
 * api/sentinel-tile-proxy.js — v9 PRODUCTION
 * ════════════════════════════════════════════════════════════════════════════
 * Sentinel Hub Process API tile proxy. Matches the working Python platform
 * (sentinel-2.py) exactly:
 *
 *  1. Dry-season time window: {year}-11-01 → {year+1}-03-31 (Ghana harmattan)
 *  2. mosaickingOrder: "leastCC", maxCloudCoverage: 25
 *  3. Try CDSE (free) first → commercial Sentinel Hub (SH_INSIGHTS) fallback
 *     Exactly mirrors: for provider in ("cdse", "insights"): ...
 *  4. Dataset auto-selection: S2-L2A (>=2015), L8-OLI-L2 (2013-14)
 *     Pre-2013 is handled by GIBS WELD on the frontend — this proxy returns
 *     null (transparent tile) for year < 2013.
 *  5. Transparent PNG for any no-data tile — never breaks MapLibre.
 *
 * ENV VARS (Vercel → Project → Settings → Environment Variables):
 *   SENTINEL_CLIENT_ID      — CDSE OAuth client ID  (sh-xxxx-xxxx-xxxx-xxxx)
 *   SENTINEL_CLIENT_SECRET  — CDSE OAuth client secret
 *   SH_INSIGHTS_CLIENT_ID      — (optional) Commercial SH client ID
 *   SH_INSIGHTS_CLIENT_SECRET  — (optional) Commercial SH client secret
 *
 *   Generate CDSE creds at: dataspace.copernicus.eu → Sign In → User Settings → OAuth Clients
 *   Generate SH creds at:   apps.sentinel-hub.com → User Settings → OAuth Clients
 * ════════════════════════════════════════════════════════════════════════════
 */

// ── Per-provider token cache (survives warm Vercel invocations) ──────────────
const _tokens = {}; // { cdse: { token, expiresAt }, insights: { token, expiresAt } }

const PROVIDERS = {
  cdse: {
    tokenUrl:   'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
    processUrl: 'https://sh.dataspace.copernicus.eu/api/v1/process',
    clientIdEnv:     'SENTINEL_CLIENT_ID',
    clientSecretEnv: 'SENTINEL_CLIENT_SECRET',
  },
  insights: {
    tokenUrl:   'https://services.sentinel-hub.com/oauth/token',
    processUrl: 'https://services.sentinel-hub.com/api/v1/process',
    clientIdEnv:     'SH_INSIGHTS_CLIENT_ID',
    clientSecretEnv: 'SH_INSIGHTS_CLIENT_SECRET',
  },
};

// ── Tile coords → WGS84 bbox [west, south, east, north] ─────────────────────
function tile2bbox(z, x, y) {
  const n = Math.pow(2, z);
  return [
    x / n * 360 - 180,
    Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI,
    (x + 1) / n * 360 - 180,
    Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI,
  ];
}

// ── OAuth2 token with per-provider in-process cache ──────────────────────────
async function getToken(providerKey) {
  const p   = PROVIDERS[providerKey];
  const cid = process.env[p.clientIdEnv];
  const sec = process.env[p.clientSecretEnv];
  if (!cid || !sec) return null; // provider not configured

  const now    = Date.now();
  const cached = _tokens[providerKey];
  if (cached && cached.expiresAt > now + 30_000) return cached.token;

  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: cid, client_secret: sec });
  const r = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) {
    console.error(`[tile-proxy] token ${providerKey} ${r.status}: ${(await r.text()).slice(0, 150)}`);
    return null;
  }
  const data = await r.json();
  if (!data.access_token) return null;
  _tokens[providerKey] = { token: data.access_token, expiresAt: now + ((data.expires_in || 600) - 60) * 1000 };
  return data.access_token;
}

// ── Evalscripts ───────────────────────────────────────────────────────────────
const EVAL_S2 = `//VERSION=3
function setup(){return{input:[{bands:["B02","B03","B04","dataMask"]}],output:{bands:4,sampleType:"UINT8"}};}
function evaluatePixel(s){let g=2.5;return[Math.round(Math.min(s.B04*g,1)*255),Math.round(Math.min(s.B03*g,1)*255),Math.round(Math.min(s.B02*g,1)*255),s.dataMask?255:0];}`;

const EVAL_OLI = `//VERSION=3
function setup(){return{input:[{bands:["B04","B03","B02","dataMask"]}],output:{bands:4,sampleType:"UINT8"}};}
function evaluatePixel(s){let g=2.5;return[Math.round(Math.min(s.B04*g,1)*255),Math.round(Math.min(s.B03*g,1)*255),Math.round(Math.min(s.B02*g,1)*255),s.dataMask?255:0];}`;

function getDataset(year) {
  const y = parseInt(year, 10);
  if (isNaN(y) || y >= 2015) return { type: 'sentinel-2-l2a', evalscript: EVAL_S2,  label: 'S2-L2A',    maxCC: 25 };
  if (y >= 2013)             return { type: 'landsat-ot-l2',  evalscript: EVAL_OLI, label: 'L8-OLI-L2', maxCC: 35 };
  return null; // pre-2013 handled by GIBS WELD on frontend
}

// ── Dry-season time window (mirrors sentinel-2.py _time_range exactly) ────────
function getTimeWindows(yrN) {
  const now      = new Date();
  const thisYear = now.getFullYear();
  if (yrN >= thisYear) {
    const safe = new Date(now.getTime() - 30 * 86400000);
    return [{ from: `${yrN}-01-01T00:00:00Z`, to: safe.toISOString().split('T')[0] + 'T23:59:59Z' }];
  }
  // Primary: dry season Nov → Mar of next year (exactly as Python platform)
  // Fallback: full year (catches edge cases where primary window has no data)
  return [
    { from: `${yrN}-11-01T00:00:00Z`, to: `${yrN + 1}-03-31T23:59:59Z` },
    { from: `${yrN}-01-01T00:00:00Z`, to: `${yrN}-12-31T23:59:59Z` },
  ];
}

// ── Call the Process API for one provider + one time window ──────────────────
async function tryProcess(providerKey, ds, bbox, w, h, win) {
  const token = await getToken(providerKey);
  if (!token) return null;

  const p = PROVIDERS[providerKey];
  const r = await fetch(p.processUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Accept': 'image/png' },
    body: JSON.stringify({
      input: {
        bounds: { bbox, properties: { crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84' } },
        data: [{ type: ds.type, dataFilter: { timeRange: { from: win.from, to: win.to }, maxCloudCoverage: ds.maxCC, mosaickingOrder: 'leastCC' } }],
      },
      output: { width: w, height: h, responses: [{ identifier: 'default', format: { type: 'image/png' } }] },
      evalscript: ds.evalscript,
    }),
  });

  if (r.status === 401 || r.status === 403) {
    delete _tokens[providerKey]; // invalidate cache
    console.warn(`[tile-proxy] auth ${r.status} on ${providerKey}`);
    return null;
  }
  if (!r.ok) return null;
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('image/')) return null;
  return r;
}

// ── 1x1 transparent PNG fallback ─────────────────────────────────────────────
const TRANSPARENT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
function sendTransparent(res, label, yr, z, x, y) {
  console.log(`[tile-proxy] transparent: ${label} yr=${yr} ${z}/${x}/${y}`);
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('X-No-Data', 'true');
  return res.status(200).send(TRANSPARENT_PNG);
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  // ── Env check ────────────────────────────────────────────────────────────────
  const hasCDSE = !!(process.env.SENTINEL_CLIENT_ID && process.env.SENTINEL_CLIENT_SECRET);
  const hasSH   = !!(process.env.SH_INSIGHTS_CLIENT_ID && process.env.SH_INSIGHTS_CLIENT_SECRET);
  if (!hasCDSE && !hasSH) {
    return res.status(500).json({
      error: 'No satellite credentials configured',
      fix:   'Set SENTINEL_CLIENT_ID + SENTINEL_CLIENT_SECRET in Vercel → Project → Settings → Environment Variables',
      how_to: 'Generate at: dataspace.copernicus.eu → Sign In → User Settings → OAuth Clients',
    });
  }

  // ── Parse tile coords ────────────────────────────────────────────────────────
  let z = parseInt(req.query.z, 10);
  let x = parseInt(req.query.x, 10);
  let y = parseInt(req.query.y, 10);
  if (isNaN(z)) { // path fallback
    const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
    const idx = parts.findIndex(p => p === 'sentinel-tile-proxy');
    if (idx !== -1 && parts.length >= idx + 4) { z = +parts[idx+1]; x = +parts[idx+2]; y = +parts[idx+3]; }
  }
  if (isNaN(z) || isNaN(x) || isNaN(y) || z < 0 || z > 22) {
    return res.status(400).json({ error: 'Invalid tile coords. Pass ?z=N&x=N&y=N' });
  }

  const yr  = req.query.year || String(new Date().getFullYear());
  const w   = Math.min(512, Math.max(64, parseInt(req.query.width  || '256', 10)));
  const h   = Math.min(512, Math.max(64, parseInt(req.query.height || '256', 10)));
  const ds  = getDataset(yr);
  const yrN = parseInt(yr, 10) || new Date().getFullYear();

  // Pre-2013: handled by GIBS WELD on the frontend — return transparent tile
  if (!ds) return sendTransparent(res, 'pre-2013-gibs', yrN, z, x, y);

  const bbox    = tile2bbox(z, x, y);
  const windows = getTimeWindows(yrN);

  // ── Try providers in order: CDSE first, SH Insights as fallback ─────────────
  // Mirrors exactly: for provider in ("cdse", "insights"): data = await _process(...)
  const providerOrder = [];
  if (hasCDSE) providerOrder.push('cdse');
  if (hasSH)   providerOrder.push('insights');

  for (const win of windows) {
    for (const provider of providerOrder) {
      let r;
      try {
        r = await tryProcess(provider, ds, bbox, w, h, win);
      } catch (err) {
        console.error(`[tile-proxy] ${provider} fetch error:`, err.message);
        continue;
      }
      if (!r) continue;

      const buf = await r.arrayBuffer();
      const pu  = r.headers.get('x-processingunits-spent') || '?';
      console.log(`[tile-proxy] OK ${provider} ${ds.label} yr=${yrN} ${z}/${x}/${y} win=${win.from.slice(0,10)} bytes=${buf.byteLength} PU=${pu}`);

      res.setHeader('Content-Type',   'image/png');
      res.setHeader('Cache-Control',  'public, max-age=86400, stale-while-revalidate=604800');
      res.setHeader('X-Dataset',      ds.label);
      res.setHeader('X-Provider',     provider);
      res.setHeader('X-Year',         String(yrN));
      res.setHeader('X-Window-From',  win.from.slice(0, 10));
      res.setHeader('X-PU-Spent',     pu);
      return res.status(200).send(Buffer.from(buf));
    }
  }

  // All providers + windows exhausted
  console.log(`[tile-proxy] all exhausted: ${ds.label} yr=${yrN} ${z}/${x}/${y}`);
  return sendTransparent(res, ds.label, yrN, z, x, y);
}