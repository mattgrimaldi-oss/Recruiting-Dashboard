const { processJob } = require('../lib/screening-engine');
const CRITERIA = require('../criteria.json');

const OWNER = 'mattgrimaldi-oss';
const REPO  = 'Recruiting-Dashboard';

async function saveScreeningResults(roles, runId) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) { console.log('No GITHUB_TOKEN — skipping results save'); return; }

  const filename = runId ? `screening-results-${runId}.json` : 'screening-results.json';
  const payload = { runAt: new Date().toISOString(), runId: runId || null, roles };

  let sha;
  try {
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${filename}?ref=main`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (r.ok) { const d = await r.json(); sha = d.sha; }
  } catch {}

  const body = {
    message: `Update screening results${runId ? ` (${runId})` : ''}`,
    content: Buffer.from(JSON.stringify(payload, null, 2)).toString('base64'),
    branch: 'main',
  };
  if (sha) body.sha = sha;

  try {
    const putRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${filename}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!putRes.ok) {
      const errText = await putRes.text();
      console.error(`Failed to save results (${putRes.status}): ${errText}`);
    } else {
      console.log(`✅ Results saved to ${filename}`);
    }
  } catch (e) {
    console.error('Failed to save results:', e.message);
  }
}

async function main() {
  const roleArg = (process.argv[2] || '').trim();
  const timeArg  = (process.argv[3] || '').trim();
  const runId    = (process.argv[4] || '').trim() || null;
  const timeWindowHoursOverride = timeArg ? Number(timeArg) : null;
  const isManual = !!(roleArg || timeArg);

  const allRoles = Object.keys(CRITERIA).filter(k => k !== 'config' && k !== '_global');

  let roles;
  if (roleArg && roleArg !== 'all') {
    roles = [roleArg];
  } else if (!roleArg && CRITERIA.config?.cronRole) {
    roles = [CRITERIA.config.cronRole];
  } else {
    roles = allRoles;
  }

  const timeWindow = timeWindowHoursOverride || CRITERIA.config?.timeWindowHours || 48;

  console.log(`\n🔍 Candidate screening started — ${new Date().toISOString()}`);
  console.log(`   Roles: ${roles.join(', ')}`);
  console.log(`   Time window: ${timeWindow}h\n`);

  const allResults = [];

  for (const role of roles) {
    console.log(`\n--- Processing: ${role.toUpperCase()} ---`);
    try {
      const results = await processJob(role, timeWindowHoursOverride, { silent: isManual });
      allResults.push({
        roleKey:  role,
        jobName:  results.jobName || role,
        passing:  results.passing || [],
        checked:  results.checked,
        notified: results.notified,
      });
      console.log(`✅ Checked: ${results.checked}`);
      console.log(`⏭️  Skipped (work auth): ${results.skipped_work_auth}`);
      console.log(`⏭️  Skipped (no resume): ${results.skipped_no_resume}`);
      console.log(`🚨 Notified: ${results.notified}`);
      if (results.candidates?.length) {
        results.candidates.forEach(c => console.log(`   ${c.passes ? '✅' : '❌'} ${c.name}`));
      }
      if (results.message) console.log(`   ${results.message}`);
    } catch (err) {
      console.error(`❌ Error processing ${role}: ${err.message}`);
    }
  }

  await saveScreeningResults(allResults, runId);

  console.log('\n✅ Screening complete.\n');
}

main();
