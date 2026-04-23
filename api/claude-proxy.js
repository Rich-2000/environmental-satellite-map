// api/claude-proxy.js
// ─────────────────────────────────────────────────────────────────────────────
// DEPLOY THIS FILE TO: /api/claude-proxy.js in your Vercel project root.
//
// Then add to Vercel Environment Variables (vercel.com → project → Settings):
//   ANTHROPIC_API_KEY = sk-ant-xxxxxxxxxxxx   (from console.anthropic.com)
//
// Also FIX your Sentinel 401 error — regenerate expired credentials:
//   SENTINEL_CLIENT_ID     = your Copernicus Data Space client ID
//   SENTINEL_CLIENT_SECRET = your Copernicus Data Space client secret
//   Steps: https://dataspace.copernicus.eu → Sign In → User Settings → OAuth Clients
//   → Create new client or regenerate secret → update in Vercel → redeploy
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY not configured in Vercel Environment Variables'
    });
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });

    const data = await anthropicRes.json();
    if (!anthropicRes.ok) return res.status(anthropicRes.status).json({ error: data.error || 'Anthropic API error', detail: data });
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
}