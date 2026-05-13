const OWNER   = 'mattgrimaldi-oss';
const REPO    = 'Recruiting-Dashboard';
const BRANCH  = 'main';
const GH_BASE = `https://api.github.com/repos/${OWNER}/${REPO}/contents`;

const FREQ_CRON = {
  every_2_days: '0 15 * * 1,3,5',
  weekly:       '0 15 * * 1',
};

async function ghGet(path, token) {
  const r = await fetch(`${GH_BASE}/${path}?ref=${BRANCH}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error(`GH GET ${path}: ${r.status}`);
  return r.json();
}

async function ghPut(path, token, content, sha, message) {
  const r = await fetch(`${GH_BASE}/${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: Buffer.from(content).toString('base64'), sha, branch: BRANCH }),
  });
  if (!r.ok) throw new Error(`GH PUT ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.GITHUB_PAT;
  if (!token) return res.status(500).json({ error: 'GITHUB_PAT not set' });

  // GET — return current criteria.json
  if (req.method === 'GET') {
    try {
      const data = await ghGet('criteria.json', token);
      const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
      return res.json({ criteria: content, sha: data.sha });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST — commit updated criteria.json (and workflow if frequency changed)
  if (req.method === 'POST') {
    let body;
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
    catch { return res.status(400).json({ error: 'Invalid JSON' }); }

    if (!body?.criteria || !body?.sha) return res.status(400).json({ error: 'Missing criteria or sha' });

    try {
      // 1. Commit criteria.json
      const result = await ghPut(
        'criteria.json', token,
        JSON.stringify(body.criteria, null, 2),
        body.sha,
        'Update screening criteria via dashboard'
      );
      const newSha = result.content.sha;

      // 2. If frequency changed, update workflow cron
      const newFreq = body.criteria.config?.frequency;
      const newCron = FREQ_CRON[newFreq];
      if (newCron) {
        try {
          const wfData = await ghGet('.github/workflows/candidate-screening.yml', token);
          const wfText = Buffer.from(wfData.content, 'base64').toString('utf-8');
          const updated = wfText.replace(/cron: '.*?'/, `cron: '${newCron}'`);
          if (updated !== wfText) {
            await ghPut(
              '.github/workflows/candidate-screening.yml', token,
              updated, wfData.sha,
              `Update screening schedule to "${newFreq}" via dashboard`
            );
          }
        } catch (e) {
          // Non-fatal — criteria saved, workflow update failed
          console.error('Workflow update failed:', e.message);
        }
      }

      return res.json({ ok: true, sha: newSha });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
