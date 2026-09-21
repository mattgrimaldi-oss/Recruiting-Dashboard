const db = require('../lib/db');

// ── Greenhouse Harvest V3 (OAuth bearer token) ──────────────────────────────
// V1 keys can no longer be created; the ATS is on Harvest V3. V3 is a
// bulk/filter API: no GET-by-id, instead list endpoints with `ids` /
// `candidate_ids` / `application_ids` filters (comma-separated, up to 50).
let _ghToken = null;
let _ghTokenExp = 0;

async function v3Token() {
  if (_ghToken && Date.now() < _ghTokenExp) return _ghToken;
  const cred = Buffer.from(
    `${process.env.GREENHOUSE_API_KEY_V3}:${process.env.GREENHOUSE_API_SECRET_V3}`
  ).toString('base64');
  const r = await fetch('https://auth.greenhouse.io/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${cred}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`Greenhouse v3 token: ${r.status}`);
  const j = await r.json();
  _ghToken = j.access_token;
  _ghTokenExp = Date.now() + ((j.expires_in || 3600) - 60) * 1000;
  return _ghToken;
}

// GET a V3 list, returning the rows (handles bare array or { results }).
async function ghList(path) {
  const token = await v3Token();
  const url = path.startsWith('http') ? path : `https://harvest.greenhouse.io/v3${path}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Greenhouse ${path}: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data && data.results ? data.results : []);
}

// GET one page of a V3 list plus the cursor URL for the next page (Link header).
async function ghPage(pathOrUrl) {
  const token = await v3Token();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `https://harvest.greenhouse.io/v3${pathOrUrl}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Greenhouse ${pathOrUrl}: ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : (data && data.results ? data.results : []);
  let next = null;
  const link = res.headers.get('link') || res.headers.get('Link') || '';
  if (link.includes('rel="next"')) {
    for (const part of link.split(',')) {
      if (part.includes('rel="next"')) { next = part.split(';')[0].trim().replace(/^<|>$/g, ''); break; }
    }
  }
  return { list, next };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, candidateId, applicationId, getPage, getContact, logDraft } = req.body;

  // ── Log an offer draft (fallback data for manually-uploaded envelopes) ─────
  if (logDraft) {
    try {
      await db.logOfferDraft({
        candidateId: logDraft.candidateId,
        applicationId: logDraft.applicationId,
        candidateName: logDraft.candidateName,
        candidateEmail: logDraft.candidateEmail,
        startDate: logDraft.startDate,
      });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Contact lookup: email + position for one candidate (offer autofill) ────
  if (getContact) {
    try {
      const [cand] = await ghList(`/candidates?ids=${getContact}`).catch(() => []);
      const email = cand?.email_addresses?.find(e => e.value)?.value ?? null;
      const apps = await ghList(`/applications?candidate_ids=${getContact}`).catch(() => []);
      const app = apps.find(a => String(a.id) === String(applicationId)) || apps[0];
      let position = null;
      if (app?.job_id) {
        const [job] = await ghList(`/jobs?ids=${app.job_id}`).catch(() => []);
        position = job?.name ?? null;
      }
      return res.json({ email, position });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Index building: cursor-paginated slim candidate list ───────────────────
  // Frontend sends { getPage: 1 } to start, then { getPage: 1, cursor } to continue.
  if (getPage) {
    try {
      let url = req.body.cursor || '/candidates?per_page=500';
      const slim = [];
      let next = null;
      let pages = 0;
      do {
        const { list, next: n } = await ghPage(url);
        for (const c of list) {
          slim.push({ id: c.id, name: `${c.first_name} ${c.last_name}`.toLowerCase().trim() });
        }
        next = n;
        url = n;
        pages++;
      } while (next && pages < 8);
      return res.json({ candidates: slim, nextCursor: next, done: !next });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Chat message ──────────────────────────────────────────────────────────
  if (!message) return res.status(400).json({ error: 'message required' });

  let contextData = '';

  if (candidateId) {
    // Profile + applications + notes in parallel
    const [profileArr, applications, notes] = await Promise.all([
      ghList(`/candidates?ids=${candidateId}`).catch(() => []),
      ghList(`/applications?candidate_ids=${candidateId}`).catch(() => []),
      ghList(`/notes?candidate_ids=${candidateId}`).catch(() => []),
    ]);
    const profile = profileArr[0];

    // Scorecards for all of this candidate's applications (batched, up to 50 ids)
    let scorecards = [];
    const appIds = applications.map(a => a.id).filter(Boolean);
    if (appIds.length) {
      scorecards = await ghList(`/scorecards?application_ids=${appIds.slice(0, 50).join(',')}`).catch(() => []);
    }

    // Resolve job names for the applications (batched)
    const jobIds = [...new Set(applications.map(a => a.job_id).filter(Boolean))];
    const jobMap = {};
    if (jobIds.length) {
      const jobs = await ghList(`/jobs?ids=${jobIds.slice(0, 50).join(',')}`).catch(() => []);
      for (const j of jobs) jobMap[j.id] = j.name;
    }

    // Resolve interviewer names for scorecards (batched)
    const userIds = [...new Set(scorecards.map(s => s.interviewer_id).filter(Boolean))];
    const userMap = {};
    if (userIds.length) {
      const users = await ghList(`/users?ids=${userIds.slice(0, 50).join(',')}`).catch(() => []);
      for (const u of users) userMap[u.id] = u.name || `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim();
    }

    if (profile) {
      contextData += `\n\n## Candidate: ${profile.first_name} ${profile.last_name}\n`;
      if (profile.title) contextData += `Current Title: ${profile.title}\n`;
      if (profile.company) contextData += `Current Company: ${profile.company}\n`;
      if (profile.phone_numbers?.length) {
        contextData += `Phone: ${profile.phone_numbers.map(p => p.value).join(', ')}\n`;
      }
      if (profile.email_addresses?.length) {
        contextData += `Email: ${profile.email_addresses.map(e => e.value).join(', ')}\n`;
      }
    }

    if (applications.length) {
      contextData += `\n## Applications:\n`;
      for (const app of applications) {
        const job = jobMap[app.job_id] || `Job ${app.job_id}`;
        contextData += `- ${job} — Stage: ${app.stage_name ?? 'Unknown'}, Status: ${app.status ?? 'Unknown'}\n`;
      }
    }

    if (notes.length) {
      contextData += `\n## Notes:\n`;
      for (const note of notes.slice(0, 20)) {
        const date = (note.created_at || '').slice(0, 10);
        const body = (note.body || '').trim();
        if (body) contextData += `[${date}] ${body}\n`;
      }
    } else {
      contextData += `\n## Notes: None found.\n`;
    }

    if (scorecards.length) {
      contextData += `\n## Interview Scorecards:\n`;
      for (const sc of scorecards) {
        const who = userMap[sc.interviewer_id] || 'Interviewer';
        contextData += `${who} — Rating: ${sc.candidate_rating ?? 'n/a'}\n`;
        const text = sc.public_notes || sc.notes || sc.private_notes || '';
        if (text.trim()) contextData += `${text.trim()}\n`;
        contextData += '\n';
      }
    }
  } else {
    // General question — provide open jobs context
    const openJobs = await ghList('/jobs?status=open').catch(() => []);
    if (openJobs.length) {
      contextData += `\n\n## Open Jobs (${openJobs.length} total):\n`;
      for (const job of openJobs.slice(0, 40)) {
        contextData += `- ${job.name} (ID: ${job.id})\n`;
      }
    }
  }

  const apiKey = process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY;
  const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4.5';

  const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: 'You are an internal recruiting assistant for Flip CX. Answer questions conversationally in natural paragraph form — no bullet points, no asterisks, no markdown formatting of any kind. Just plain prose, direct and concise.' },
        { role: 'user', content: `${message}\n\n---\nGreenhouse Data:${contextData || ' No data found.'}` },
      ],
    }),
  });

  const aiData = await aiRes.json();
  const answer = aiData.choices?.[0]?.message?.content || aiData.error?.message || 'No response.';

  return res.json({ answer });
};
