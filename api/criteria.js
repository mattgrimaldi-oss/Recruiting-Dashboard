const OWNER    = 'mattgrimaldi-oss';
const REPO     = 'Recruiting-Dashboard';
const FILE     = 'criteria.json';
const BRANCH   = 'main';
const GH_BASE  = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.GITHUB_PAT;
  if (!token) return res.status(500).json({ error: 'GITHUB_PAT not set' });

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  // GET — return current criteria.json from GitHub
  if (req.method === 'GET') {
    const r = await fetch(`${GH_BASE}?ref=${BRANCH}`, { headers });
    if (!r.ok) return res.status(r.status).json({ error: 'Failed to fetch criteria' });
    const data = await r.json();
    const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    return res.json({ criteria: content, sha: data.sha });
  }

  // POST — commit updated criteria.json to GitHub
  if (req.method === 'POST') {
    let body;
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

    if (!body?.criteria || !body?.sha) {
      return res.status(400).json({ error: 'Missing criteria or sha' });
    }

    const encoded = Buffer.from(JSON.stringify(body.criteria, null, 2)).toString('base64');

    const r = await fetch(GH_BASE, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: 'Update screening criteria via dashboard',
        content: encoded,
        sha: body.sha,
        branch: BRANCH,
      }),
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: err });
    }
    const result = await r.json();
    return res.json({ ok: true, sha: result.content.sha });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
