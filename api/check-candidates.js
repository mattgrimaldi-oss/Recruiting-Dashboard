const Anthropic = require('@anthropic-ai/sdk');
const pdfParse = require('pdf-parse');

// ─── Job Configurations ───────────────────────────────────────────────────────

const TODAY = new Date().toISOString().slice(0, 10);
const TWO_MONTHS_AGO = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 7);

const RECENCY_CRITERION = `EMPLOYMENT RECENCY — Currently employed OR most recent role ended within 2 months of today (${TODAY}). If an end date only shows a year (e.g. "2025") with no month, treat it as December of that year. If December of that year is more than 2 months before today, fail this criterion.`;

const JOB_CONFIGS = [
  {
    jobId: '4462684008',
    jobName: 'Account Executive',
    criteriaPrompt: `Today's date is ${TODAY}.

CRITERIA (1, 2, 4, and 5 must ALL be met to pass — criterion 3 is informational only):
1. SALES EXPERIENCE — At least 1 year as an Account Executive OR at least 3 years as a BDR/SDR. SaaS experience preferred.
2. STARTUP EXPERIENCE — At least one employer was a startup or company with under 200 employees. Ideally 10–100 employees.
3. EDUCATION (informational only, does not affect pass/fail) — Note whether they have a bachelor's degree and when they graduated.
4. QUOTA ATTAINMENT — Resume explicitly mentions exceeding quota (e.g. "130% of quota", "exceeded targets", "#1 rep", etc.)
5. ${RECENCY_CRITERION}`,
    criteriaKeys: [
      { key: 'sales_experience', label: 'Sales experience' },
      { key: 'startup_experience', label: 'Startup background' },
      { key: 'education', label: 'Education', informational: true },
      { key: 'quota_attainment', label: 'Quota attainment' },
      { key: 'employment_recency', label: 'Employment recency' },
    ],
    jsonShape: `{
  "passes": true or false,
  "criteria": {
    "sales_experience": { "met": true or false, "detail": "one concise sentence" },
    "startup_experience": { "met": true or false, "detail": "one concise sentence" },
    "education": { "met": true or false, "detail": "one concise sentence" },
    "quota_attainment": { "met": true or false, "detail": "one concise sentence" },
    "employment_recency": { "met": true or false, "detail": "one concise sentence" }
  },
  "summary": "1 sentence — why they pass or the main reason they fail",
  "highlights": ["most impressive thing", "second most impressive thing"],
  "bonus_signals": []
}`,
  },
  {
    jobId: '4203780008',
    jobName: 'Software Engineer',
    criteriaPrompt: `Today's date is ${TODAY}.

CRITERIA (1, 2, 3, 4, and 5 must ALL be met to pass — signals in criterion 6 are informational only):
1. ENGINEERING EXPERIENCE — 7+ years of full stack engineering experience. SaaS experience preferred.
2. STARTUP EXPERIENCE — At least one employer was a startup or company with under 200 employees. Ideally 10–100 employees.
3. EDUCATION — Bachelor's degree in Computer Science, Information Management Systems, Applied Math, or a related technical/CS field. Must have graduated in 2018 or earlier.
4. PYTHON — Python must appear on the resume as a language they have used.
5. ${RECENCY_CRITERION}
6. BONUS SIGNALS (informational only, do not affect pass/fail — note each if present):
   - React experience
   - AWS experience
   - AI product or AI SaaS company experience
   - Voice AI or speech tech experience
   - Prestigious university (top 50 US university)`,
    criteriaKeys: [
      { key: 'engineering_experience', label: 'Engineering experience' },
      { key: 'startup_experience', label: 'Startup background' },
      { key: 'education', label: 'Education' },
      { key: 'python', label: 'Python' },
      { key: 'employment_recency', label: 'Employment recency' },
    ],
    jsonShape: `{
  "passes": true or false,
  "criteria": {
    "engineering_experience": { "met": true or false, "detail": "one concise sentence" },
    "startup_experience": { "met": true or false, "detail": "one concise sentence" },
    "education": { "met": true or false, "detail": "one concise sentence" },
    "python": { "met": true or false, "detail": "one concise sentence" },
    "employment_recency": { "met": true or false, "detail": "one concise sentence" }
  },
  "summary": "1 sentence — why they pass or the main reason they fail",
  "highlights": ["most impressive thing", "second most impressive thing"],
  "bonus_signals": ["list any bonus signals found — React, AWS, AI, voice AI, prestigious university — or empty array if none"]
}`,
  },
];

// ─── Greenhouse ───────────────────────────────────────────────────────────────

async function fetchGreenhouse(path) {
  const auth = Buffer.from(`${process.env.GREENHOUSE_API_KEY_V1}:`).toString('base64');
  const res = await fetch(`https://harvest.greenhouse.io/v1${path}`, {
    headers: { 'Authorization': `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Greenhouse ${path}: ${res.status}`);
  return res.json();
}

// ─── Work Authorization (hard filter) ────────────────────────────────────────

function isWorkAuthorized(application) {
  const answers = application.answers || [];
  const authAnswer = answers.find(a =>
    a.question?.toLowerCase().includes('authorized') ||
    a.question?.toLowerCase().includes('sponsorship') ||
    a.question?.toLowerCase().includes('work authorization')
  );
  if (!authAnswer) return { authorized: true, flagForReview: true };
  const yes = authAnswer.answer?.toLowerCase().includes('yes');
  return { authorized: yes, flagForReview: false };
}

// ─── Resume parsing ───────────────────────────────────────────────────────────

async function parseResume(candidate) {
  const resumeAttachment = candidate.attachments?.find(a => a.type === 'resume');
  if (!resumeAttachment) return null;

  const fileRes = await fetch(resumeAttachment.url);
  if (!fileRes.ok) return null;

  const contentType = fileRes.headers.get('content-type') || '';
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  if (contentType.includes('pdf') || resumeAttachment.filename?.toLowerCase().endsWith('.pdf')) {
    const parsed = await pdfParse(buffer);
    return parsed.text;
  }

  return buffer.toString('utf-8').replace(/[^\x20-\x7E\n]/g, ' ');
}

// ─── Claude scoring ───────────────────────────────────────────────────────────

async function scoreCandidate(resumeText, candidateName, jobConfig) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: 'You are a strict recruiting assistant. Evaluate candidates precisely against the criteria given. Do not give benefit of the doubt — only mark a criterion as met if there is clear evidence in the resume.',
    messages: [{
      role: 'user',
      content: `Evaluate this resume for a ${jobConfig.jobName} role.

${jobConfig.criteriaPrompt}

Respond ONLY with valid JSON — no markdown, no explanation outside the JSON:
${jobConfig.jsonShape}

Resume for ${candidateName}:
---
${resumeText}`,
    }],
  });

  try {
    return JSON.parse(completion.content[0].text);
  } catch {
    return null;
  }
}

// ─── Slack formatting ─────────────────────────────────────────────────────────

function formatSlackMessage(candidateName, candidateId, score, jobConfig, flagForReview) {
  const c = score.criteria;

  const checks = jobConfig.criteriaKeys.map(({ key, label, informational }) => {
    const criterion = c[key];
    if (!criterion) return null;
    const icon = informational ? 'ℹ️' : criterion.met ? '✅' : '❌';
    return `${icon} *${label}:* ${criterion.detail}`;
  }).filter(Boolean).join('\n');

  const highlights = score.highlights?.length
    ? `\n*Highlights:*\n${score.highlights.map(h => `• ${h}`).join('\n')}`
    : '';

  const bonusSignals = score.bonus_signals?.length
    ? `\n*Bonus signals:* ${score.bonus_signals.join(' · ')}`
    : '';

  const reviewFlag = flagForReview
    ? '\n⚠️ _Work auth question not found — verify manually_'
    : '';

  return `🚨 *Strong Candidate — ${jobConfig.jobName}*

*${candidateName}*
${score.summary}

${checks}${highlights}${bonusSignals}${reviewFlag}

👉 <https://app8.greenhouse.io/people/${candidateId}|View in Greenhouse>`;
}

async function postToSlack(message) {
  const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
  if (!res.ok) throw new Error(`Slack post failed: ${res.status}`);
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const results = { jobs: {}, total_checked: 0, total_notified: 0 };

  try {
    // Process all jobs in parallel
    const jobResultsAll = await Promise.all(JOB_CONFIGS.map(async (jobConfig) => {
      const jobResults = { checked: 0, skipped_work_auth: 0, skipped_no_resume: 0, notified: 0, candidates: [] };

      const applications = await fetchGreenhouse(
        `/applications?job_id=${jobConfig.jobId}&status=active&created_after=${since}&per_page=100`
      );

      if (!Array.isArray(applications) || applications.length === 0) {
        return { jobName: jobConfig.jobName, ...jobResults, message: 'No new applications in the last 48 hours.' };
      }

      // Filter before hitting candidate API
      const eligible = applications.filter(app => {
        if (!app.current_stage?.name?.toLowerCase().includes('application review')) return false;
        const { authorized } = isWorkAuthorized(app);
        if (!authorized) { jobResults.skipped_work_auth++; return false; }
        return true;
      });

      jobResults.checked = applications.length;

      // Process candidates in batches of 3 to avoid Claude rate limits
      for (let i = 0; i < eligible.length; i += 3) {
        const batch = eligible.slice(i, i + 3);
        await Promise.all(batch.map(async (app) => {
        const { flagForReview } = isWorkAuthorized(app);
        const candidate = await fetchGreenhouse(`/candidates/${app.candidate_id}`);
        const resumeText = await parseResume(candidate);

        if (!resumeText) { jobResults.skipped_no_resume++; return; }

        const candidateName = `${candidate.first_name} ${candidate.last_name}`;
        const score = await scoreCandidate(resumeText, candidateName, jobConfig);
        if (!score) return;

        jobResults.candidates.push({ name: candidateName, passes: score.passes });

        if (score.passes) {
          const message = formatSlackMessage(candidateName, candidate.id, score, jobConfig, flagForReview);
          await postToSlack(message);
          jobResults.notified++;
        }
      }));
      }

      return { jobName: jobConfig.jobName, ...jobResults };
    }));

    for (const jr of jobResultsAll) {
      const { jobName, ...rest } = jr;
      results.jobs[jobName] = rest;
      results.total_checked += rest.checked || 0;
      results.total_notified += rest.notified || 0;
    }

    return res.json({ success: true, ...results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
