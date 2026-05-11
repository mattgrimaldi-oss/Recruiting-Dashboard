const Anthropic = require('@anthropic-ai/sdk');
const pdfParse = require('pdf-parse');
const path = require('path');

// ─── Load criteria config ─────────────────────────────────────────────────────

function loadCriteria() {
  // Always re-require so updates to criteria.json are picked up
  delete require.cache[require.resolve('../config/criteria.json')];
  return require('../config/criteria.json');
}

// ─── Build Claude prompt from criteria config ─────────────────────────────────

function buildPrompt(roleConfig, today) {
  const { criteria, bonusSignals = [] } = roleConfig;
  const hard = criteria.filter(c => c.required && !c.informational);
  const soft = criteria.filter(c => !c.required || c.informational);

  const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 7);

  const hardNums = hard.map((_, i) => i + 1).join(', ');
  let header = `Today's date is ${today}.\n\nCRITERIA (criteria ${hardNums} must ALL be met to pass`;
  if (soft.length) header += ` — remaining criteria are informational only`;
  if (bonusSignals.length) header += `. Bonus signals are informational only`;
  header += `):\n`;

  let num = 1;
  let promptBody = '';
  [...hard, ...soft].forEach(c => {
    let desc = c.description;
    if (c.dynamic) desc += ` Today is ${today} so 2 months ago is ${twoMonthsAgo}. If end date is year-only, treat as December of that year.`;
    const infoNote = c.informational ? ' (informational only, does not affect pass/fail)' : '';
    promptBody += `${num}. ${c.label.toUpperCase()}${infoNote} — ${desc}\n`;
    num++;
  });

  if (bonusSignals.length) {
    promptBody += `${num}. BONUS SIGNALS (informational only — note each if present):\n`;
    bonusSignals.forEach(b => { promptBody += `   - ${b}\n`; });
  }

  return header + promptBody;
}

function buildJsonShape(criteria, hasBonus) {
  const fields = criteria.map(c =>
    `    "${c.key}": { "met": true or false, "detail": "one concise sentence" }`
  ).join(',\n');

  return `{
  "passes": true or false,
  "criteria": {
${fields}
  },
  "summary": "1 sentence — why they pass or the main reason they fail",
  "highlights": ["most impressive thing", "second most impressive thing"]${hasBonus ? ',\n  "bonus_signals": ["list any found — or empty array"]' : ''}
}`;
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

async function scoreCandidate(resumeText, candidateName, roleConfig, today) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const hasBonus = (roleConfig.bonusSignals || []).length > 0;

  const completion = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 800,
    system: 'You are a strict recruiting assistant. Only mark a criterion as met if there is clear evidence in the resume. Respond only with valid JSON.',
    messages: [{
      role: 'user',
      content: `Evaluate this resume for a ${roleConfig.jobName} role.\n\n${buildPrompt(roleConfig, today)}\nRespond ONLY with valid JSON:\n${buildJsonShape(roleConfig.criteria, hasBonus)}\n\nResume for ${candidateName}:\n---\n${resumeText}`,
    }],
  });

  try {
    return JSON.parse(completion.content[0].text);
  } catch {
    return null;
  }
}

// ─── Slack ────────────────────────────────────────────────────────────────────

function formatSlackMessage(candidateName, candidateId, roleConfig, location) {
  const locationLine = location ? `\n${location}` : '';
  return `<https://app8.greenhouse.io/people/${candidateId}|${candidateName}>\n${roleConfig.jobName}${locationLine}`;
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
  const allCriteria = loadCriteria();
  const roleConfig = allCriteria[roleKey];
  if (!roleConfig) throw new Error(`Unknown role: ${roleKey}`);

  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const results = {
    jobName: roleConfig.jobName,
    checked: 0,
    skipped_work_auth: 0,
    skipped_no_resume: 0,
    notified: 0,
    candidates: [],
  };

  const applications = await fetchGreenhouse(
    `/applications?job_id=${roleConfig.jobId}&status=active&created_after=${since}&per_page=100`
  );

  if (!Array.isArray(applications) || applications.length === 0) {
    return { ...results, message: 'No new applications in the last 48 hours.' };
  }

  results.checked = applications.length;

  const eligible = applications.filter(app => {
    if (!app.current_stage?.name?.toLowerCase().includes('application review')) return false;
    const { authorized } = isWorkAuthorized(app);
    if (!authorized) { results.skipped_work_auth++; return false; }
    return true;
  });

  for (const app of eligible) {
    const { flagForReview } = isWorkAuthorized(app);
    const candidate = await fetchGreenhouse(`/candidates/${app.candidate_id}`);
    const resumeText = await parseResume(candidate);

    if (!resumeText) { results.skipped_no_resume++; continue; }

    const candidateName = `${candidate.first_name} ${candidate.last_name}`;
    const score = await scoreCandidate(resumeText, candidateName, roleConfig, today);
    if (!score) continue;

    const location = candidate.addresses?.[0]?.value || null;

    results.candidates.push({
      name: candidateName,
      candidateId: String(candidate.id),
      location,
      passes: score.passes,
      summary: score.summary || null,
    });

    if (score.passes) {
      await postToSlack(formatSlackMessage(candidateName, candidate.id, roleConfig, location));
      results.notified++;
    }
  }

  return results;
}

module.exports = { processJob };
