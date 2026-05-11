const { processJob } = require('../lib/screening-engine');

async function main() {
  console.log(`\n🔍 Candidate screening started — ${new Date().toISOString()}\n`);

  for (const role of ['ae', 'swe']) {
    console.log(`\n--- Processing: ${role.toUpperCase()} ---`);
    try {
      const results = await processJob(role);
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

  console.log('\n✅ Screening complete.\n');
}

main();
