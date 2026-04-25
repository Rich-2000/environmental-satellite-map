/**
 * sentinel-token.js
 * ═══════════════════════════════════════════════════════════════════
 * Fetches a Copernicus Data Space (CDSE) OAuth2 token and also
 * returns the instance ID needed to construct correct WMS URLs.
 *
 * The client calls POST /api/sentinel-token and receives:
 *   { access_token, expires_in, instance_id }
 *
 * The instance_id is the full SENTINEL_CLIENT_ID value.
 * CDSE WMS URLs use it in the path:
 *   https://sh.dataspace.copernicus.eu/ogc/wms/{instance_id}
 * ═══════════════════════════════════════════════════════════════════
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const clientId     = process.env.SENTINEL_CLIENT_ID;
  const clientSecret = process.env.SENTINEL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'Sentinel credentials not configured' });
  }

  try {
    const body = new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
    });

    const tokenRes = await fetch(
      'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    body.toString(),
      }
    );

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      return res.status(tokenRes.status).json({
        error:  'Token fetch failed',
        detail: errText,
      });
    }

    const data = await tokenRes.json();

    return res.status(200).json({
      access_token: data.access_token,
      expires_in:   data.expires_in,
      instance_id:  clientId,  // Full client_id is the WMS instance identifier
    });

  } catch (err) {
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
}