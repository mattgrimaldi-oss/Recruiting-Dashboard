const Anthropic = require('@anthropic-ai/sdk');

async function fetchGreenhouse(path) {
  const auth = Buffer.from(`${process.env.GREENHOUSE_API_KEY_V1}:`).toString('base64');
  const res = await fetch(`https://harvest.greenhouse.io/v1${path}`, {
    headers: { 'Authorization': `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Greenhouse ${path}: ${res.status}`);
  return res.json();
}

async function buildCandidateIndex() {
  const index = {};
  let page = 1;
  while (true) {
    const candidates = await fetchGreenhouse(`/candidates?per_page=500&page=${page}`);
    if (!Array.isArray(candidates) || candidates.length === 0) break;
    for (const c of candidates) {
      const name = `${c.first_name} ${c.last_name}`.toLowerCase().trim();
      const appId = c.applications?.[0]?.id ?? null;
      index[name] = { candidateId: c.id, applicationId: appId };
    }
    if (candidates.length < 500) break;
    page++;
  }
  return index;
}

function findCandidateInMessage(message, index) {
  const msg = message.toLowerCase();
  let bestMatch = null;
  let bestLen = 0;
  for (const name of Object.keys(index)) {
    if (msg.includes(name) && name.length > bestLen) {
      bestMatch = name;
      bestLen = name.length;
    }
  }
  return bestMatch;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, candidateIndex: clientIndex, buildIndex } = req.body;

  if (buildIndex) {
    try {
      const index = await buildCandidateIndex();
      return res.json({ candidateIndex: index });
    } catch (e) {
      return res.status(500).json({ error: `Failed to build index: ${e.message}` });
    }
  }

  if (!message) return res.status(400).json({ error: 'message required' });

  const index = clientIndex || {};
  const candidateName = findCandidateInMessage(message, index);
  const candidateData = candidateName ? index[candidateName] : null;

  let contextData = '';

  if (candidateData) {
    const { candidateId, applicationId } = candidateData;

    const fetches = [
      fetchGreenhouse(`/candidates/${candidateId}`).catch(() => null),
      fetchGreenhouse(`/candidates/${candidateId}/activity_feed`).catch(() => null),
    ];
    if (applicationId) {
      fetches.push(fetchGreenhouse(`/applications/${applicationId}/scorecards`).catch(() => null));
    }

    const [profile, activityFeed, scorecards] = await Promise.all(fetches);

    if (profile) {
      contextData += `\n\n## Candidate Profile: ${candidateName}\n`;
      if (profile.phone_numbers?.length) {
        contextData += `Phone: ${profile.phone_numbers.map(p => p.value).join(', ')}\n`;
      }
      if (profile.email_addresses?.length) {
        contextData += `Email: ${profile.email_addresses.map(e => e.value).join(', ')}\n`;
      }
      if (profile.applications?.length) {
        const app = profile.applications[0];
        contextData += `Current Stage: ${app.current_stage?.name ?? 'Unknown'}\n`;
        contextData += `Status: ${app.status}\n`;
        if (app.jobs?.length) {
          contextData += `Applied For: ${app.jobs.map(j => j.name).join(', ')}\n`;
        }
      }
    }

    if (activityFeed?.notes?.length) {
      contextData += `\n\n## Notes:\n`;
      for (const note of activityFeed.notes.slice(0, 15)) {
        const date = note.created_at?.slice(0, 10) ?? '';
        const author = note.user?.name ?? 'Unknown';
        contextData += `[${date} — ${author}]: ${note.body}\n`;
      }
    }

    if (scorecards?.length) {
      contextData += `\n\n## Interview Scorecards:\n`;
      for (const sc of scorecards) {
        contextData += `Interviewer: ${sc.interviewer?.name ?? 'Unknown'}\n`;
        contextData += `Recommendation: ${sc.overall_recommendation}\n`;
        for (const q of sc.questions ?? []) {
          if (q.answer) contextData += `${q.question}: ${q.answer}\n`;
        }
        contextData += '\n';
      }
    }
  } else {
    // General question — provide open jobs context
    const openJobs = await fetchGreenhouse('/jobs?status=open').catch(() => null);
    if (openJobs) {
      contextData += `\n\n## Open Jobs (${openJobs.length} total):\n`;
      for (const job of openJobs.slice(0, 30)) {
        contextData += `- ${job.name} (ID: ${job.id})\n`;
      }
    }
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: 'You are an internal recruiting assistant for Flip CX. Answer questions concisely using only the Greenhouse data provided. If specific data is not available, say so clearly. Be direct and helpful.',
    messages: [{
      role: 'user',
      content: `${message}\n\n---\nGreenhouse Data:${contextData || ' No matching candidate or data found.'}`,
    }],
  });

  return res.json({ answer: completion.content[0].text });
};
