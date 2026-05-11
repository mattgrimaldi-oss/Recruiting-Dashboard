const { processJob } = require('../lib/screening-engine');

const GITHUB_OWNER = 'mattgrimaldi-oss';
const GITHUB_REPO = 'Recruiting-Dashboard';
const RESULTS_PATH = 'data/screening-results.json';

async function saveResultsToGitHub(results) {
  const pat = process.env.GITHUB_PAT;
  if (!pat) { console.log('No GITHUB_PAT — skipping results save'); return; }

  const headers = {
    'Authorization': `token ${pat}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  // Get current file SHA
  const getRes = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${RESULTS_PATH}`,
    { headers }
  );
  const current = await getRes.json();
  const sha = current.sha;

  const content = Buffer.from(JSON.stringify(results, null, 2)).toString('base64');

  const putRes = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${RESULTS_PATH}`,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `screening results — ${new Date().toISOString().slice(0, 10)}`,
        content,
        sha,
        branch: 'main',
      }),
    }
  );

  if (putRes.ok) {
    console.log('✅ Results saved to GitHub');
  } else {
    const err = await putRes.json();
    console.error('❌ Failed to save results:', err.message);
  }
}

async function main() {
  console.log(`\n🔍 Candidate screening started — ${new Date().toISOString()}\n`);

  const results = { lastRun: new Date().toISOString(), jobs: {} };

  for (const role of ['ae', 'swe']) {
    console.log(`\n--- Processing: ${role.toUpperCase()} ---`);
    try {
      const jobResults = await processJob(role);
      results.jobs[role] = jobResults;

      console.log(`✅ Checked: ${jobResults.checked}`);
      console.log(`⏭️  Skipped (work auth): ${jobResults.skipped_work_auth}`);
      console.log(`⏭️  Skipped (no resume): ${jobResults.skipped_no_resume}`);
      console.log(`🚨 Notified: ${jobResults.notified}`);
      if (jobResults.candidates?.length) {
        jobResults.candidates.forEach(c =>
          console.log(`   ${c.passes ? '✅' : '❌'} ${c.name}`)
        );
      }
      if (jobResults.message) console.log(`   ${jobResults.message}`);
    } catch (err) {
      console.error(`❌ Error processing ${role}: ${err.message}`);
      results.jobs[role] = { error: err.message };
    }
  }

  await saveResultsToGitHub(results);
  console.log('\n✅ Screening complete.\n');
}

main();
