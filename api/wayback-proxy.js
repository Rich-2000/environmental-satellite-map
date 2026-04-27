/**
 * api/wayback-proxy.js — v1 PRODUCTION
 * ═══════════════════════════════════════════════════════════════════
 * Proxies Esri Living Atlas Wayback WMTS tiles to fix CORS.
 *
 * WHY: wayback.maptiles.arcgis.com does NOT send Access-Control-Allow-Origin
 *      headers, so browsers block direct tile requests from vercel domains.
 *      This proxy fetches the tile server-side and forwards it with CORS headers.
 *
 * URL pattern: /api/wayback-proxy?itemId=26&z={z}&y={y}&x={x}
 *
 * Esri Wayback item IDs by year (West Africa / Accra composites):
 *   2014: 10 | 2015: 26 | 2016: 30 | 2017: 46 | 2018: 58
 *   2019: 62 | 2020: 75 | 2021: 82 | 2022: 88 | 2023: 92
 *   2024: 97 | 2025: 101
 * ═══════════════════════════════════════════════════════════════════
 */

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

  const esriUrl = `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default/${itemId}/GoogleMapsCompatible/${z}/${y}/${x}`;

  try {
    const upstream = await fetch(esriUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 AccraWatch/1.0',
        'Referer':    'https://www.arcgis.com/',
      }
    });

    if (!upstream.ok) {
      // Return transparent 1x1 PNG — tiles may simply not exist for this area/zoom
      const TRANSPARENT_PNG = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64'
      );
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(200).send(TRANSPARENT_PNG);
    }

    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    const buf = await upstream.arrayBuffer();

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    return res.status(200).send(Buffer.from(buf));

  } catch (err) {
    console.error('[wayback-proxy] error:', err.message);
    return res.status(500).json({ error: 'Proxy error', detail: err.message });
  }
}