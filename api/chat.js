const Anthropic = require('@anthropic-ai/sdk');
const db = require('../lib/db');

async function fetchGreenhouse(path) {
  const auth = Buffer.from(`${process.env.GREENHOUSE_API_KEY_V1}:`).toString('base64');
  const res = await fetch(`https://harvest.greenhouse.io/v1${path}`, {
    headers: { 'Authorization': `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Greenhouse ${path}: ${res.status}`);
  return res.json();
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
  // Per-candidate (not bulk) so this doesn't expose a harvestable email list.
  if (getContact) {
    try {
      const cand = await fetchGreenhouse(`/candidates/${getContact}`).catch(() => null);
      const email = cand?.email_addresses?.find(e => e.value)?.value ?? null;
      // Position = the job on the linked application (fall back to first app).
      let position = null;
      const apps = cand?.applications || [];
      const app = apps.find(a => String(a.id) === String(applicationId)) || apps[0];
      position = app?.jobs?.[0]?.name ?? null;
      return res.json({ email, position });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Index building: return a slim page of candidates ──────────────────────
  if (getPage) {
    try {
      const candidates = await fetchGreenhouse(`/candidates?per_page=500&page=${getPage}`);
      if (!Array.isArray(candidates)) return res.json({ candidates: [], done: true });
      const slim = candidates.map(c => ({
        id: c.id,
        name: `${c.first_name} ${c.last_name}`.toLowerCase().trim(),
        appId: c.applications?.[0]?.id ?? null,
      }));
      return res.json({ candidates: slim, done: candidates.length < 500 });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Chat message ──────────────────────────────────────────────────────────
  if (!message) return res.status(400).json({ error: 'message required' });

  let contextData = '';

  if (candidateId) {
    const [profile, activityFeed] = await Promise.all([
      fetchGreenhouse(`/candidates/${candidateId}`).catch(() => null),
      fetchGreenhouse(`/candidates/${candidateId}/activity_feed`).catch(() => null),
    ]);

    // Fetch scorecards for ALL applications, not just the first one
    let scorecards = [];
    if (profile?.applications?.length) {
      const allScorecards = await Promise.all(
        profile.applications.map(app =>
          fetchGreenhouse(`/applications/${app.id}/scorecards`).catch(() => [])
        )
      );
      scorecards = allScorecards.flat().filter(Boolean);
    } else if (applicationId) {
      scorecards = await fetchGreenhouse(`/applications/${applicationId}/scorecards`).catch(() => []);
    }

    if (profile) {
      contextData += `\n\n## Candidate: ${profile.first_name} ${profile.last_name}\n`;
      if (profile.phone_numbers?.length) {
        contextData += `Phone: ${profile.phone_numbers.map(p => p.value).join(', ')}\n`;
      }
      if (profile.email_addresses?.length) {
        contextData += `Email: ${profile.email_addresses.map(e => e.value).join(', ')}\n`;
      }
      for (const app of profile.applications ?? []) {
        contextData += `Application — Job: ${app.jobs?.map(j => j.name).join(', ') ?? 'Unknown'}, Stage: ${app.current_stage?.name ?? 'Unknown'}, Status: ${app.status}\n`;
      }
    }

    if (activityFeed?.notes?.length) {
      contextData += `\n\n## Notes:\n`;
      for (const note of activityFeed.notes.slice(0, 15)) {
        const date = note.created_at?.slice(0, 10) ?? '';
        const author = note.user?.name ?? 'Unknown';
        contextData += `[${date} — ${author}]: ${note.body}\n`;
      }
    } else {
      contextData += `\n\n## Notes: None found.\n`;
    }

    if (scorecards?.length) {
      contextData += `\n\n## Interview Scorecards:\n`;
      for (const sc of scorecards) {
        contextData += `Interviewer: ${sc.interviewer?.name ?? 'Unknown'}\n`;
        contextData += `Recommendation: ${sc.overall_recommendation}\n`;
        for (const q of sc.questions ?? []) {
          if (q.answer) contextData += `${q.question}: ${q.answer}\n`;
        }
        for (const a of sc.attributes ?? []) {
          if (a.note) contextData += `${a.name}: ${a.note}\n`;
          if (a.rating && a.rating !== 'no_decision') contextData += `${a.name} rating: ${a.rating}\n`;
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
    system: 'You are an internal recruiting assistant for Flip CX. Answer questions conversationally in natural paragraph form — no bullet points, no asterisks, no markdown formatting of any kind. Just plain prose, direct and concise.',
    messages: [{
      role: 'user',
      content: `${message}\n\n---\nGreenhouse Data:${contextData || ' No data found.'}`,
    }],
  });

  return res.json({ answer: completion.content[0].text });
};
