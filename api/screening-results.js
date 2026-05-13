const OWNER = 'mattgrimaldi-oss';
const REPO  = 'Recruiting-Dashboard';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.GITHUB_PAT;
  if (!token) return res.status(500).json({ error: 'GITHUB_PAT not set' });

  try {
    const runId = req.query?.runId || null;
    const filename = runId ? `screening-results-${runId}.json` : 'screening-results.json';
    const r = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${filename}?ref=main`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
    );
    if (!r.ok) return res.status(r.status).json({ error: 'Results not found' });
    const data = await r.json();
    const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    return res.json(content);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
