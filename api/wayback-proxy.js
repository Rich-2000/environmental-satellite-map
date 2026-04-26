/**
 * api/wayback-proxy.js — v2 PRODUCTION
 * ═══════════════════════════════════════════════════════════════════
 * Proxies Esri Living Atlas Wayback WMTS tiles to fix CORS.
 * Falls back to NASA GIBS MODIS TrueColor when Wayback tile unavailable.
 *
 * WHY: wayback.maptiles.arcgis.com does NOT send Access-Control-Allow-Origin
 *      headers, so browsers block direct tile requests from Vercel domains.
 *      This proxy fetches the tile server-side and forwards it with CORS headers.
 *
 * URL pattern: /api/wayback-proxy?itemId=97&year=2024&z={z}&y={y}&x={x}
 *
 * Esri Wayback item IDs by year (West Africa / Accra composites):
 *   2014: 10 | 2015: 26 | 2016: 30 | 2017: 46 | 2018: 58
 *   2019: 62 | 2020: 75 | 2021: 82 | 2022: 88 | 2023: 92
 *   2024: 97 | 2025: 101
 *
 * Fallback chain (when Wayback tile 404s or is empty):
 *   1. Esri Wayback WMTS tile
 *   2. NASA GIBS MODIS Terra CorrectedReflectance TrueColor (year-dated, zoom ≤9)
 *   3. Transparent 1×1 PNG
 * ═══════════════════════════════════════════════════════════════════
 */

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

// Best dry-season GIBS date for a given year (harmattan = Jan-Mar for Ghana)
function gibsDateForYear(year) {
  const y = parseInt(year, 10);
  const now = new Date();
  const thisYear = now.getFullYear();
  if (!y || y < 2000) return '2003-01-15';
  if (y >= thisYear) {
    const safe = new Date(now.getTime() - 45 * 86_400_000);
    return safe.toISOString().split('T')[0];
  }
  if (y === 2000) return '2000-03-15';
  return `${y}-01-15`;
}

// Build a NASA GIBS TrueColor tile URL (only works for zoom ≤ 9)
function gibsTileUrl(year, z, y, x) {
  const date = gibsDateForYear(year);
  return (
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/` +
    `MODIS_Terra_CorrectedReflectance_TrueColor/default/${date}/` +
    `GoogleMapsCompatible_Level9/${z}/${y}/${x}.jpg`
  );
}

// Check if a tile buffer is a real image (not an empty/error body)
function isRealImage(buf, contentType) {
  if (!buf || buf.length < 200) return false; // too small to be real
  const ct = (contentType || '').toLowerCase();
  return ct.includes('image/jpeg') || ct.includes('image/png') || ct.includes('image/jpg');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { itemId, year, z, y, x } = req.query;

  if (!itemId || isNaN(parseInt(z)) || isNaN(parseInt(y)) || isNaN(parseInt(x))) {
    return res.status(400).json({ error: 'Missing or invalid params. Required: itemId, z, y, x' });
  }

  const zi = parseInt(z, 10);
  const yi = parseInt(y, 10);
  const xi = parseInt(x, 10);
  const yr = parseInt(year || '0', 10);

  // ── STEP 1: Try Esri Wayback ─────────────────────────────────────────────
  const esriUrl =
    `https://wayback.maptiles.arcgis.com/arcgis/rest/services/` +
    `World_Imagery/WMTS/1.0.0/default/${itemId}/GoogleMapsCompatible/${zi}/${yi}/${xi}`;

  try {
    const upstream = await fetch(esriUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 AccraWatch/2.0',
        'Referer':    'https://www.arcgis.com/',
        'Accept':     'image/jpeg,image/png,image/*,*/*',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (upstream.ok) {
      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await upstream.arrayBuffer());

      if (isRealImage(buf, contentType)) {
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
        res.setHeader('X-Tile-Source', 'esri-wayback');
        return res.status(200).send(buf);
      }
      // Esri returned something but it wasn't a valid image — fall through
      console.warn(`[wayback-proxy] Wayback tile suspicious (${buf.length}B, ${contentType}) — trying GIBS`);
    } else {
      console.warn(`[wayback-proxy] Wayback tile ${upstream.status} for itemId=${itemId} ${zi}/${yi}/${xi}`);
    }
  } catch (err) {
    console.warn('[wayback-proxy] Wayback fetch error:', err.message);
  }

  // ── STEP 2: Fall back to NASA GIBS MODIS TrueColor (zoom ≤ 9 only) ───────
  if (yr >= 2000 && zi <= 9) {
    try {
      const gibs = await fetch(gibsTileUrl(yr, zi, yi, xi), {
        headers: { 'User-Agent': 'AccraWatch/2.0' },
        signal: AbortSignal.timeout(8000),
      });

      if (gibs.ok) {
        const ct  = gibs.headers.get('content-type') || 'image/jpeg';
        const buf = Buffer.from(await gibs.arrayBuffer());

        if (isRealImage(buf, ct)) {
          res.setHeader('Content-Type', ct);
          res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
          res.setHeader('X-Tile-Source', 'nasa-gibs-fallback');
          console.log(`[wayback-proxy] GIBS fallback used for year=${yr} ${zi}/${yi}/${xi}`);
          return res.status(200).send(buf);
        }
      }
    } catch (gibsErr) {
      console.warn('[wayback-proxy] GIBS fallback error:', gibsErr.message);
    }
  }

  // ── STEP 3: Transparent PNG ───────────────────────────────────────────────
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('X-Tile-Source', 'transparent-fallback');
  return res.status(200).send(TRANSPARENT_PNG);
}