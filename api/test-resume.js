const Anthropic = require('@anthropic-ai/sdk');
const pdfParse = require('pdf-parse');

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
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { job_id } = req.query;
  if (!job_id) {
    return res.status(400).json({ error: 'job_id query param required. e.g. /api/test-resume?job_id=12345' });
  }

  try {
    // 1. Pull the 5 most recent applications for this job
    const applications = await fetchGreenhouse(`/applications?job_id=${job_id}&per_page=5`);
    if (!Array.isArray(applications) || applications.length === 0) {
      return res.json({ message: 'No applications found for this job_id.' });
    }

    // 2. Find the first application that has a resume attached
    let candidateName = null;
    let resumeText = null;
    let foundApp = null;

    for (const app of applications) {
      const candidate = await fetchGreenhouse(`/candidates/${app.candidate_id}`);
      const resumeAttachment = candidate.attachments?.find(a => a.type === 'resume');

      if (!resumeAttachment) continue;

      candidateName = `${candidate.first_name} ${candidate.last_name}`;

      // 3. Download the resume file
      const fileRes = await fetch(resumeAttachment.url);
      if (!fileRes.ok) {
        continue; // try next candidate
      }

      const contentType = fileRes.headers.get('content-type') || '';
      const buffer = Buffer.from(await fileRes.arrayBuffer());

      // 4. Extract text — PDF or plain text fallback
      if (contentType.includes('pdf') || resumeAttachment.filename?.endsWith('.pdf')) {
        const parsed = await pdfParse(buffer);
        resumeText = parsed.text;
      } else {
        // DOCX or plain text — use raw buffer as string (rough fallback)
        resumeText = buffer.toString('utf-8').replace(/[^\x20-\x7E\n]/g, ' ');
      }

      foundApp = app;
      break;
    }

    if (!resumeText) {
      return res.json({ message: 'No resume attachments found on the last 5 applications for this job.' });
    }

    // 5. Send to Claude for parsing
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: 'You are a recruiting assistant. Extract structured information from resumes accurately and concisely.',
      messages: [{
        role: 'user',
        content: `Parse this resume and return the following in a clean structured format:

1. **Companies worked at** — list each company, estimated size if inferable (startup/mid/large), and years there
2. **Total years of experience**
3. **Most recent title**
4. **Any SaaS, voice AI, or speech tech experience** — be specific if found
5. **Y Combinator or Sequoia-backed companies** — flag if any employer is known to be YC or Sequoia backed

Resume:
---
${resumeText}`,
      }],
    });

    return res.json({
      candidate: candidateName,
      applicationId: foundApp?.id,
      resumePreview: resumeText.slice(0, 600).trim() + '…',
      claudeAnalysis: completion.content[0].text,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
