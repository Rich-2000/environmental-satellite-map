/**
 * api/wayback-proxy.js — v2 PRODUCTION
 * ═══════════════════════════════════════════════════════════════════
 * Proxies Esri Living Atlas Wayback WMTS tiles server-side.
 *
 * WHY: Acts as a CORS safety net — Esri Wayback tiles are CORS-open on
 *      their CDN, but some edge cases (auth, rate limits, certain proxies)
 *      can block direct browser requests. This proxy is a fallback.
 *
 * URL: /api/wayback-proxy?itemId=<releaseNum>&z={z}&y={y}&x={x}
 *
 * The `itemId` parameter is the Esri Wayback WMTS release sequence number.
 * These are the same numbers used in the direct tile URL:
 *   https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/
 *   WMTS/1.0.0/default/<releaseNum>/GoogleMapsCompatible/{z}/{y}/{x}
 *
 * Confirmed release numbers (April 2026 audit):
 *   2014: 10 | 2015: 26 | 2016: 30 | 2017: 46 | 2018: 58
 *   2019: 62 | 2020: 75 | 2021: 82 | 2022: 88 | 2023: 92
 *   2024: 97 | 2025: 101
 * ═══════════════════════════════════════════════════════════════════
 */

// 1x1 transparent PNG — returned when Esri returns no tile (no coverage)
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
  const zi = parseInt(z,  10);
  const yi = parseInt(y,  10);
  const xi = parseInt(x,  10);
  const id = parseInt(itemId, 10);

  if (!itemId || isNaN(zi) || isNaN(yi) || isNaN(xi) || isNaN(id) || id < 1) {
    return res.status(400).json({ error: 'Missing/invalid params. Required: itemId, z, y, x' });
  }

  // Validate zoom range — Wayback tiles exist for zoom 0-23
  if (zi < 0 || zi > 23) {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(TRANSPARENT_PNG);
  }

  const esriUrl = `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default/${id}/GoogleMapsCompatible/${zi}/${yi}/${xi}`;

  try {
    const upstream = await fetch(esriUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 AccraWatch/2.0',
        'Referer':    'https://www.arcgis.com/',
        'Accept':     'image/webp,image/jpeg,image/png,image/*,*/*',
      },
      signal: AbortSignal.timeout(8000), // 8s timeout
    });

    if (!upstream.ok) {
      // 404 = no tile at this location/zoom — return transparent, not an error
      console.log(`[wayback-proxy] No tile: release=${id} z=${zi}/${xi}/${yi} status=${upstream.status}`);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(200).send(TRANSPARENT_PNG);
    }

    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    if (!contentType.includes('image/')) {
      // Non-image response — return transparent
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(200).send(TRANSPARENT_PNG);
    }

    const buf = await upstream.arrayBuffer();
    console.log(`[wayback-proxy] ✓ release=${id} z=${zi}/${xi}/${yi} bytes=${buf.byteLength}`);

    res.setHeader('Content-Type',  contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('X-Wayback-Release', String(id));
    return res.status(200).send(Buffer.from(buf));

  } catch (err) {
    console.error('[wayback-proxy] fetch error:', err.message);
    // Return transparent tile on network errors — keep the map rendering
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).send(TRANSPARENT_PNG);
  }
}