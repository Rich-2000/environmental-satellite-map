/**
 * api/wayback-proxy.js — v2 PRODUCTION
 * ═══════════════════════════════════════════════════════════════════
 * Proxies Esri Living Atlas Wayback WMTS tiles to fix CORS.
 *
 * WHY: wayback.maptiles.arcgis.com does NOT send Access-Control-Allow-Origin
 *      headers, so browsers block direct tile requests from Vercel domains.
 *      This proxy fetches the tile server-side and forwards it with CORS headers.
 *
 * FIX vs v1: The correct Wayback tile URL uses "default028mm/MapServer/tile/"
 *      NOT "default/GoogleMapsCompatible/" — this matches the working platform
 *      (esri_wayback.py: TILE_URL_TMPL) and is the only URL that returns real
 *      dated archive tiles. The wrong path returns 404 for every tile.
 *
 * URL pattern: /api/wayback-proxy?itemId=26&z={z}&y={y}&x={x}
 *
 * Esri Wayback item IDs are release numbers from the Wayback config JSON.
 * They are fetched live by the frontend (_loadWaybackVintages) and fall back
 * to hardcoded values:
 *   2014: 10 | 2015: 26 | 2016: 30 | 2017: 46 | 2018: 58
 *   2019: 62 | 2020: 75 | 2021: 82 | 2022: 88 | 2023: 92
 *   2024: 97 | 2025: 101
 * ═══════════════════════════════════════════════════════════════════
 */

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { itemId, z, y, x } = req.query;

  if (!itemId || isNaN(parseInt(z)) || isNaN(parseInt(y)) || isNaN(parseInt(x))) {
    return res.status(400).json({ error: 'Missing or invalid params. Required: itemId, z, y, x' });
  }

  // ── CORRECT URL FORMAT (matches esri_wayback.py TILE_URL_TMPL) ────────────
  // Working platform uses: default028mm/MapServer/tile/{release}/{z}/{y}/{x}
  // Previous v1 used:      default/{itemId}/GoogleMapsCompatible/{z}/{y}/{x}  ← WRONG (404)
  const esriUrl = `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${itemId}/${z}/${y}/${x}`;

  try {
    const upstream = await fetch(esriUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 AccraWatch/1.0',
        'Referer':    'https://livingatlas.arcgis.com/wayback/',
      }
    });

    if (!upstream.ok) {
      console.log(`[wayback-proxy] ${upstream.status} for itemId=${itemId} ${z}/${y}/${x}`);
      res.setHeader('Content-Type',  'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('X-No-Data',     'true');
      return res.status(200).send(TRANSPARENT_PNG);
    }

    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    const buf = await upstream.arrayBuffer();
    console.log(`[wayback-proxy] OK itemId=${itemId} ${z}/${y}/${x} bytes=${buf.byteLength}`);

    res.setHeader('Content-Type',  contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('X-Wayback-Id',  String(itemId));
    return res.status(200).send(Buffer.from(buf));

  } catch (err) {
    console.error('[wayback-proxy] fetch error:', err.message);
    // Return transparent tile so MapLibre doesn't show broken tile icon
    res.setHeader('Content-Type',  'image/png');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).send(TRANSPARENT_PNG);
  }
}