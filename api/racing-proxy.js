/**
 * Vercel Serverless Function: Racing Post proxy
 * Fetches racingpost.com pages server-side to bypass CORS.
 * Only allows racingpost.com URLs for security.
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const url = req.query.url;

  if (!url || !/^https:\/\/(www\.)?racingpost\.com\//.test(url)) {
    return res.status(400).json({ error: 'Only racingpost.com URLs are allowed.' });
  }

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Accept-Encoding': 'identity'
      },
      redirect: 'follow'
    });

    if (!resp.ok) {
      return res.status(resp.status).json({ error: 'Racing Post returned HTTP ' + resp.status });
    }

    let html = await resp.text();

    // Strip heavy assets to reduce payload — keep scripts that carry data
    html = html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<link\s[^>]*rel=["']stylesheet["'][^>]*>/gi, '')
      .replace(/<img[^>]*>/gi, '')
      .replace(/<video[\s\S]*?<\/video>/gi, '')
      .replace(/<svg[\s\S]*?<\/svg>/gi, '')
      .replace(/<picture[\s\S]*?<\/picture>/gi, '');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=120');
    return res.status(200).send(html);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
