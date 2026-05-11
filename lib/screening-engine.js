const Anthropic = require('@anthropic-ai/sdk');
const pdfParse = require('pdf-parse');
const path = require('path');

const TODAY = new Date().toISOString().slice(0, 10);

// Load criteria from criteria.json (editable via dashboard UI)
const CRITERIA_PATH = path.join(__dirname, '..', 'criteria.json');
const CRITERIA_FILE = require(CRITERIA_PATH);

function buildCriteriaPrompt(roleConfig) {
  const { criteria } = roleConfig;
  const requiredNums = criteria.map((c, i) => c.required ? i + 1 : null).filter(Boolean);
  const infoNums    = criteria.map((c, i) => !c.required ? i + 1 : null).filter(Boolean);

  let header = `CRITERIA (${requiredNums.join(', and ')} must ALL be met to pass`;
  if (infoNums.length) {
    header += ` — criterion ${infoNums.join(', ')} ${infoNums.length === 1 ? 'is' : 'are'} informational only`;
  }
  header += '):';

  const lines = criteria.map((c, i) => {
    const num = i + 1;
    const tag = c.required ? '' : ' (informational only, does not affect pass/fail)';
    return `${num}. ${c.label.toUpperCase()}${tag} — ${c.detail}`;
  });

  return `Today's date is ${TODAY}.\n\n${header}\n${lines.join('\n')}`;
}

function buildJsonShape(roleConfig) {
  const { criteria, bonus } = roleConfig;
  const fields = criteria.map(c =>
    `    "${c.key}": { "met": true or false, "detail": "one concise sentence" }`
  ).join(',\n');

  const bonusNote = bonus && bonus.length
    ? `["list any found: ${bonus.join(', ')} — or empty array"]`
    : '[]';

  return `{
  "passes": true or false,
  "criteria": {
${fields}
  },
  "summary": "1 sentence — why they pass or the main reason they fail",
  "highlights": ["most impressive thing", "second most impressive thing"],
  "bonus_signals": ${bonusNote}
}`;
}

// Build JOB_CONFIGS dynamically from criteria.json
const JOB_CONFIGS = {};
for (const [roleKey, roleConfig] of Object.entries(CRITERIA_FILE)) {
  JOB_CONFIGS[roleKey] = {
    jobId: roleConfig.jobId,
    jobName: roleConfig.jobName,
    criteriaPrompt: buildCriteriaPrompt(roleConfig),
    criteriaKeys: roleConfig.criteria.map(c => ({
      key: c.key,
      label: c.label,
      ...(c.required ? {} : { informational: true }),
    })),
    jsonShape: buildJsonShape(roleConfig),
  };
}

// ─── Greenhouse ───────────────────────────────────────────────────────────────

async function fetchGreenhouse(path) {
  const auth = Buffer.from(`${process.env.GREENHOUSE_API_KEY_V1}:`).toString('base64');
  const res = await fetch(`https://harvest.greenhouse.io/v1${path}`, {
    headers: { 'Authorization': `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Greenhouse ${path}: ${res.status}`);
  return res.json();
}

// ─── Work authorization ───────────────────────────────────────────────────────

function isWorkAuthorized(application) {
  const answers = application.answers || [];
  const authAnswer = answers.find(a =>
    a.question?.toLowerCase().includes('authorized') ||
    a.question?.toLowerCase().includes('sponsorship') ||
    a.question?.toLowerCase().includes('work authorization')
  );
  if (!authAnswer) return { authorized: true, flagForReview: true };
  return { authorized: authAnswer.answer?.toLowerCase().includes('yes'), flagForReview: false };
}

// ─── Resume parsing ───────────────────────────────────────────────────────────

async function parseResume(candidate) {
  const attachment = candidate.attachments?.find(a => a.type === 'resume');
  if (!attachment) return null;
  const fileRes = await fetch(attachment.url);
  if (!fileRes.ok) return null;
  const contentType = fileRes.headers.get('content-type') || '';
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  if (contentType.includes('pdf') || attachment.filename?.toLowerCase().endsWith('.pdf')) {
    const parsed = await pdfParse(buffer);
    return parsed.text;
  }
  return buffer.toString('utf-8').replace(/[^\x20-\x7E\n]/g, ' ');
}

// ─── Claude scoring ───────────────────────────────────────────────────────────

async function scoreCandidate(resumeText, candidateName, jobConfig) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const completion = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 800,
    system: 'You are a strict recruiting assistant. Only mark a criterion as met if there is clear evidence in the resume. Respond only with valid JSON.',
    messages: [{
      role: 'user',
      content: `Evaluate this resume for a ${jobConfig.jobName} role.\n\n${jobConfig.criteriaPrompt}\n\nRespond ONLY with valid JSON:\n${jobConfig.jsonShape}\n\nResume for ${candidateName}:\n---\n${resumeText}`,
    }],
  });
  try {
    return JSON.parse(completion.content[0].text);
  } catch {
    return null;
  }
}

// ─── Slack ────────────────────────────────────────────────────────────────────

function formatSlackMessage(candidateName, candidateId, jobConfig, location) {
  const locationLine = location ? `\n${location}` : '';
  return `<https://app8.greenhouse.io/people/${candidateId}|${candidateName}>\n${jobConfig.jobName}${locationLine}`;
}

async function postToSlack(message) {
  const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
  if (!res.ok) throw new Error(`Slack post failed: ${res.status}`);
}

// ─── Core job processor ───────────────────────────────────────────────────────

async function processJob(roleKey) {
  const jobConfig = JOB_CONFIGS[roleKey];
  if (!jobConfig) throw new Error(`Unknown role: ${roleKey}`);

  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const results = { checked: 0, skipped_work_auth: 0, skipped_no_resume: 0, notified: 0, candidates: [] };

  const applications = await fetchGreenhouse(
    `/applications?job_id=${jobConfig.jobId}&status=active&created_after=${since}&per_page=100`
  );

  if (!Array.isArray(applications) || applications.length === 0) {
    return { message: 'No new applications in the last 48 hours.', ...results };
  }

  results.checked = applications.length;

  const eligible = applications.filter(app => {
    if (!app.current_stage?.name?.toLowerCase().includes('application review')) return false;
    const { authorized } = isWorkAuthorized(app);
    if (!authorized) { results.skipped_work_auth++; return false; }
    return true;
  });

  for (const app of eligible) {
    const candidate = await fetchGreenhouse(`/candidates/${app.candidate_id}`);
    const resumeText = await parseResume(candidate);

    if (!resumeText) { results.skipped_no_resume++; continue; }

    const candidateName = `${candidate.first_name} ${candidate.last_name}`;
    const score = await scoreCandidate(resumeText, candidateName, jobConfig);
    if (!score) continue;

    results.candidates.push({ name: candidateName, passes: score.passes });

    if (score.passes) {
      const location = candidate.addresses?.[0]?.value || null;
      await postToSlack(formatSlackMessage(candidateName, candidate.id, jobConfig, location));
      results.notified++;
    }
  }

  return results;
}

module.exports = { processJob };
