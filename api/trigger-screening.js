const OWNER = 'mattgrimaldi-oss';
const REPO  = 'Recruiting-Dashboard';
const WORKFLOW = 'candidate-screening.yml';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.GITHUB_PAT;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN not set' });

  // GET — return last workflow run info
  if (req.method === 'GET') {
    const r = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
    );
    if (!r.ok) return res.status(r.status).json({ error: 'GitHub API error' });
    const data = await r.json();
    const run = data.workflow_runs?.[0];
    if (!run) return res.json({ lastRun: null });
    return res.json({
      lastRun: run.updated_at,
      createdAt: run.created_at,
      status: run.status,
      conclusion: run.conclusion,
    });
  }

  // POST — trigger workflow
  if (req.method === 'POST') {
    let body = {};
    try { body = req.body ? (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) : {}; } catch {}
    const inputs = {};
    if (body.role && body.role !== 'all') inputs.role = body.role;
    if (body.timeWindowHours) inputs.time_window_hours = String(body.timeWindowHours);
    if (body.runId) inputs.run_id = body.runId;

    const r = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main', inputs }),
      }
    );
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: text });
    }
    return res.json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
