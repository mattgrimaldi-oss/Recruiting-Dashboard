const Anthropic = require('@anthropic-ai/sdk');
const pdfParse = require('pdf-parse');
const path = require('path');

const TODAY = new Date().toISOString().slice(0, 10);

// Load criteria from criteria.json (editable via dashboard UI)
const CRITERIA_PATH = path.join(__dirname, '..', 'criteria.json');
const CRITERIA_FILE = require(CRITERIA_PATH);

function buildCriteriaPrompt(roleConfig) {
  const { criteria } = roleConfig;
  const required    = criteria.filter(c => c.status === 'required');
  const bonus       = criteria.filter(c => c.status === 'bonus');
  const notRequired = criteria.filter(c => c.status === 'not_required');

  const sections = [`Today's date is ${TODAY}.`];

  if (required.length > 0) {
    const reqLines = required.map((c, i) => `${i + 1}. ${c.label.toUpperCase()} — ${c.detail}`);
    sections.push(`REQUIRED — candidate must meet ALL of these to pass:\n${reqLines.join('\n')}`);
  } else {
    sections.push('There are no required criteria. The candidate passes automatically.');
  }

  if (bonus.length > 0) {
    const bonusLines = bonus.map(c => `- ${c.label.toUpperCase()} — ${c.detail}`);
    sections.push(`BONUS — note these as positive signals but they do NOT affect pass/fail:\n${bonusLines.join('\n')}`);
  }

  if (notRequired.length > 0) {
    const nrLines = notRequired.map(c => `- ${c.label.toUpperCase()} — ${c.detail}`);
    sections.push(`NOT REQUIRED — note these for context but they do NOT affect pass/fail:\n${nrLines.join('\n')}`);
  }

  return sections.join('\n\n');
}

function buildJsonShape(roleConfig) {
  const { criteria } = roleConfig;
  const required = criteria.filter(c => c.status === 'required');
  const bonus = criteria.filter(c => c.status === 'bonus');
  const notRequired = criteria.filter(c => c.status === 'not_required');

  const reqFields = required.map(c =>
    `    "${c.key}": { "met": true or false, "detail": "one concise sentence" }`
  ).join(',\n');

  const bonusFields = bonus.map(c =>
    `    "${c.key}": "one concise sentence noting what you found"`
  ).join(',\n');

  const nrFields = notRequired.map(c =>
    `    "${c.key}": "one concise sentence noting what you found"`
  ).join(',\n');

  let shape = `{\n  "passes": true or false,\n  "location": "city, state from resume or null if not found"`;
  if (reqFields) shape += `,\n  "criteria": {\n${reqFields}\n  }`;
  if (bonusFields) shape += `,\n  "bonus": {\n${bonusFields}\n  }`;
  if (nrFields) shape += `,\n  "notes": {\n${nrFields}\n  }`;
  shape += `,\n  "summary": "1 sentence — why they pass or the main reason they fail",\n  "highlights": ["most impressive thing", "second most impressive thing"]\n}`;
  return shape;
}

// Build JOB_CONFIGS dynamically from criteria.json
const globalCriteria = CRITERIA_FILE._global?.criteria || [];
const JOB_CONFIGS = {};
for (const [roleKey, roleConfig] of Object.entries(CRITERIA_FILE).filter(([k]) => k !== 'config' && k !== '_global')) {
  const roleSpecificKeys = new Set(roleConfig.criteria.map(c => c.key));
  const filteredGlobal = globalCriteria.filter(c => !roleSpecificKeys.has(c.key));
  const mergedConfig = { ...roleConfig, criteria: [...filteredGlobal, ...roleConfig.criteria] };
  JOB_CONFIGS[roleKey] = {
    jobIds: Array.isArray(roleConfig.jobIds) ? roleConfig.jobIds : [roleConfig.jobId],
    jobName: roleConfig.jobName,
    requiredCount: mergedConfig.criteria.filter(c => c.status === 'required').length,
    criteriaPrompt: buildCriteriaPrompt(mergedConfig),
    criteriaKeys: mergedConfig.criteria.map(c => ({
      key: c.key,
      label: c.label,
      ...(c.status !== 'required' ? { informational: true } : {}),
    })),
    jsonShape: buildJsonShape(mergedConfig),
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

async function scoreCandidate(resumeText, candidateName, jobConfig, attempt = 1) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    const completion = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      system: 'You are a recruiting assistant. Evaluate the candidate generously — mark a criterion as met if the resume reasonably suggests the candidate satisfies the intent, even if not every detail is explicitly stated. When a criterion says "note whether", treat it as met if the candidate has the attribute mentioned. Respond only with valid JSON.',
      messages: [{
        role: 'user',
        content: `Evaluate this resume for a ${jobConfig.jobName} role.\n\n${jobConfig.criteriaPrompt}\n\nRespond ONLY with valid JSON:\n${jobConfig.jsonShape}\n\nResume for ${candidateName}:\n---\n${resumeText}`,
      }],
    });
    let text = completion.content[0].text.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    return JSON.parse(text);
  } catch (err) {
    const status = err.status || err.statusCode;
    if (attempt < 3 && (status === 500 || status === 529)) {
      await new Promise(r => setTimeout(r, 10000 * attempt));
      return scoreCandidate(resumeText, candidateName, jobConfig, attempt + 1);
    }
    console.error(`Claude error for ${candidateName}: ${err.message}`);
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

async function processJob(roleKey, timeWindowHoursOverride, { silent = false } = {}) {
  const jobConfig = JOB_CONFIGS[roleKey];
  if (!jobConfig) throw new Error(`Unknown role: ${roleKey}`);

  const timeWindowHours = timeWindowHoursOverride || CRITERIA_FILE.config?.timeWindowHours || 48;
  const since = new Date(Date.now() - timeWindowHours * 60 * 60 * 1000).toISOString();
  const results = { checked: 0, skipped_work_auth: 0, skipped_no_resume: 0, notified: 0, candidates: [] };

  const allApplications = [];
  for (const jobId of jobConfig.jobIds) {
    const apps = await fetchGreenhouse(
      `/applications?job_id=${jobId}&status=active&created_after=${since}&per_page=100`
    );
    if (Array.isArray(apps)) allApplications.push(...apps);
  }
  const applications = allApplications;

  if (applications.length === 0) {
    if (!silent) await postToSlack(`No candidates found — ${jobConfig.jobName}`);
    return { message: 'No new applications in the last 48 hours.', ...results };
  }

  results.checked = applications.length;

  const eligible = applications.filter(app => {
    if (!app.current_stage?.name?.toLowerCase().includes('application review')) return false;
    const { authorized } = isWorkAuthorized(app);
    if (!authorized) { results.skipped_work_auth++; return false; }
    return true;
  });

  const passing = [];

  for (const app of eligible) {
    const candidate = await fetchGreenhouse(`/candidates/${app.candidate_id}`);
    const resumeText = await parseResume(candidate);

    if (!resumeText) { results.skipped_no_resume++; continue; }

    const candidateName = `${candidate.first_name} ${candidate.last_name}`;
    let score;
    if (jobConfig.requiredCount === 0) {
      score = { passes: true };
    } else {
      await new Promise(r => setTimeout(r, 4000));
      score = await scoreCandidate(resumeText, candidateName, jobConfig);
      if (!score) continue;
    }

    results.candidates.push({ name: candidateName, passes: score.passes });
    console.log(`   📋 ${candidateName} score:`, JSON.stringify(score, null, 2));

    if (score.passes) {
      const location = score.location || candidate.addresses?.[0]?.value || null;
      passing.push({ name: candidateName, id: candidate.id, location });
      if (passing.length >= 5) break;
    }
  }

  if (!silent) {
    if (passing.length > 0) {
      const lines = passing.map(c => `• <https://app8.greenhouse.io/people/${c.id}|${c.name}>${c.location ? ' — ' + c.location : ''}`);
      const message = `*${jobConfig.jobName} — ${passing.length} passed*\n${lines.join('\n')}`;
      await postToSlack(message);
      results.notified = passing.length;
    } else {
      await postToSlack(`No candidates found — ${jobConfig.jobName}`);
    }
  }

  results.jobName = jobConfig.jobName;
  results.passing = passing;
  return results;
}

module.exports = { processJob };
