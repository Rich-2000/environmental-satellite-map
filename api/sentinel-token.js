/**
 * sentinel-token.js — v3 PRODUCTION
 * ═══════════════════════════════════════════════════════════════════
 * Fetches a Copernicus Data Space (CDSE) OAuth2 token.
 *
 * FIX v3: Accept GET requests in addition to POST.
 *   Browsers visiting the URL directly (e.g. for debugging) use GET.
 *   Old v2 only allowed POST → returned 405 "Method not allowed" to
 *   the health-check URL typed into the browser address bar.
 *   Both methods now return { access_token, expires_in }.
 *
 * The token is used by the browser only for diagnostic purposes.
 * All actual tile fetching is done server-side in sentinel-tile-proxy.js.
 * ═══════════════════════════════════════════════════════════════════
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Accept both GET (browser URL bar / health check) and POST (app fetch)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const clientId     = process.env.SENTINEL_CLIENT_ID;
  const clientSecret = process.env.SENTINEL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({
      error: 'Sentinel credentials not configured',
      hint:  'Set SENTINEL_CLIENT_ID and SENTINEL_CLIENT_SECRET in Vercel → Settings → Environment Variables'
    });
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
        detail: errText.slice(0, 300),
        hint:   'Check that your SENTINEL_CLIENT_ID and SENTINEL_CLIENT_SECRET are correct and not expired. ' +
                'Regenerate at: dataspace.copernicus.eu → Sign In → User Settings → OAuth Clients'
      });
    }

    const data = await tokenRes.json();

    return res.status(200).json({
      access_token: data.access_token,
      expires_in:   data.expires_in,
      // Note: no instance_id needed — Process API uses OAuth token directly
    });

  } catch (err) {
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
}