const GITHUB_OWNER = 'mattgrimaldi-oss';
const GITHUB_REPO = 'Recruiting-Dashboard';
const FILE_PATH = 'config/criteria.json';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const updated = req.body;
    const headers = {
      'Authorization': `token ${process.env.GITHUB_PAT}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };

    // Get current SHA
    const getRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`,
      { headers }
    );
    const current = await getRes.json();

    const content = Buffer.from(JSON.stringify(updated, null, 2)).toString('base64');

    const putRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: `update screening criteria — ${new Date().toISOString().slice(0, 10)}`,
          content,
          sha: current.sha,
          branch: 'main',
        }),
      }
    );

    if (putRes.ok) {
      return res.json({ success: true });
    } else {
      const err = await putRes.json();
      return res.status(500).json({ error: err.message });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
