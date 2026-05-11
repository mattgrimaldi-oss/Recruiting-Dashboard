const GITHUB_OWNER = 'mattgrimaldi-oss';
const GITHUB_REPO = 'Recruiting-Dashboard';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/config/criteria.json`,
      {
        headers: {
          'Authorization': `token ${process.env.GITHUB_PAT}`,
          'Accept': 'application/vnd.github.v3+json',
        },
      }
    );
    const file = await response.json();
    const content = JSON.parse(Buffer.from(file.content, 'base64').toString('utf-8'));
    return res.json(content);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
